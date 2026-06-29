import express from 'express';
import path from 'path';
import Stripe from 'stripe';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { GoogleGenAI, Type } from '@google/genai';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

function validateEnv() {
  const required = ['STRIPE_WEBHOOK_SECRET'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
validateEnv();

import firebaseConfig from './firebase-applet-config.json' with { type: 'json' };

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  initializeApp({
    credential: cert(serviceAccount),
    projectId: firebaseConfig.projectId,
  });
} else {
  initializeApp({
    projectId: firebaseConfig.projectId,
  });
}

// Target the specific dynamic firestore database ID
const adminDb = getFirestore(firebaseConfig.firestoreDatabaseId);

const app = express();
const PORT = 3000;

// Required for Firebase signInWithPopup: allows our page to communicate with
// the Google OAuth popup window even though it is cross-origin.
// Without this header the browser blocks window.closed checks on the popup.
app.use((_req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  next();
});

// Lazy initialize Stripe instance to prevent backend crashes when secret key is unset on boot
let stripeClient: Stripe | null = null;
function getStripe(): Stripe {
  if (!stripeClient) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error('STRIPE_SECRET_KEY environment variable is required');
    }
    stripeClient = new Stripe(key, {
      apiVersion: '2025-01-27.accredited' as any,
    });
  }
  return stripeClient;
}

// Special raw body parser for Stripe secure signature verification
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  // Guaranteed non-null by validateEnv() at startup
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET as string;

  if (!sig) {
    res.status(400).send('Webhook Error: Missing Stripe Signature header.');
    return;
  }

  try {
    const stripe = getStripe();
    const event = stripe.webhooks.constructEvent(req.body, sig as string, webhookSecret);

    console.log(`Received webhook event: ${event.type}`);

    // Handle payment success event of Stripe subscriptions
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.client_reference_id;
      
      if (userId) {
        console.log(`Stripe subscription checkout succeeded for user: ${userId}`);
        const userRef = adminDb.collection('users').doc(userId);
        
        await userRef.set({
          subscription: {
            status: 'active',
            plan: 'Pro',
            billingCycle: 'monthly',
            createdAt: new Date().toISOString(),
            stripeSessionId: session.id,
            stripeCustomerId: typeof session.customer === 'string' ? session.customer : session.customer?.id || null
          }
        }, { merge: true });

        console.log(`User ${userId} upgraded to Pro in Firestore successfully.`);
      } else {
        console.warn('Missing client_reference_id (userId) in checkout session.');
      }
    }

    res.json({ received: true });
  } catch (err: any) {
    console.error(`Webhook Error: ${err.message}`);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// JSON body parser for other normal API routes
app.use(express.json());

// Allowlisted origins for Stripe redirect URLs — populated from APP_URL env var
// plus localhost for development.  Never trust a client-supplied URL.
const ALLOWED_REDIRECT_ORIGINS = new Set<string>(
  [process.env.APP_URL, 'http://localhost:3000']
    .filter(Boolean)
    .map(u => { try { return new URL(u!).origin; } catch { return ''; } })
    .filter(Boolean)
);

function resolveRedirectBase(clientHint: string | undefined): string {
  if (clientHint) {
    try {
      const origin = new URL(clientHint).origin;
      if (ALLOWED_REDIRECT_ORIGINS.has(origin)) {
        return origin;
      }
    } catch { /* ignore malformed URLs */ }
  }
  return process.env.APP_URL || 'http://localhost:3000';
}

// API route to create a checkout session
app.post('/api/stripe/create-checkout-session', async (req, res) => {
  const { userId, userEmail, appUrl } = req.body;

  if (!userId) {
    res.status(400).json({ error: 'Missing userId parameter' });
    return;
  }

  try {
    const stripe = getStripe();

    const baseUrl = resolveRedirectBase(appUrl);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'TheDesignAI Pro Plan',
              description: 'Unlock unlimited design generations, real-time AI Design Co-Pilot, and manual Tailwind code edits.',
            },
            unit_amount: 1400, // $14 USD
            recurring: {
              interval: 'month',
            },
          },
          quantity: 1,
        },
      ],
      mode: 'subscription',
      client_reference_id: userId,
      customer_email: userEmail || undefined,
      success_url: `${baseUrl}?session_id={CHECKOUT_SESSION_ID}&checkout_success=true`,
      cancel_url: `${baseUrl}?checkout_cancelled=true`,
    });

    res.json({ id: session.id, url: session.url });
  } catch (error: any) {
    console.error('Error creating checkout session:', error);
    res.status(500).json({ error: error.message });
  }
});

// Sync endpoint to look up live Firebase/Stripe profile status
app.get('/api/stripe/status/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const userDoc = await adminDb.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      res.json({ active: false, plan: 'Free' });
      return;
    }
    const data = userDoc.data();
    const isPro = data?.subscription?.status === 'active';
    res.json({ active: isPro, subscription: data?.subscription || null });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --------------- AI Proxy Routes ---------------

async function callOpenRouter(systemInstruction: string, prompt: string, isJson: boolean) {
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (!openRouterKey) {
    throw new Error('Both GEMINI_API_KEY and OPENROUTER_API_KEY fallback are missing.');
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openRouterKey}`,
      'X-Title': 'TheDesignAI'
    },
    body: JSON.stringify({
      model: 'google/gemini-2.5-flash',
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: prompt }
      ],
      temperature: isJson ? 0.7 : 0.2,
      response_format: isJson ? { type: 'json_object' } : undefined
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || '';
  const usage = {
    promptTokenCount: data.usage?.prompt_tokens || 0,
    candidatesTokenCount: data.usage?.completion_tokens || 0,
    totalTokenCount: data.usage?.total_tokens || 0
  };

  return { text, usage };
}

function cleanJsonString(str: string): string {
  let cleaned = str.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/i, '').replace(/\s*```$/i, '');
  }
  return cleaned.trim();
}

app.post('/api/ai/generate-variants', async (req, res) => {
  const { prompt, questions, answers } = req.body;
  if (!prompt) { res.status(400).json({ error: 'Missing prompt' }); return; }

  const systemInstruction = `
    You are Flash UI, a master UI/UX designer and world-class frontend engineer.
    Your mission is to generate THREE RADICAL CONCEPTUAL VARIATIONS for the user's prompt.
    The user might request a UI, a poster, a logo, or any other visual layout. Adapt your HTML/Tailwind output to perfectly suit the requested medium.

    **STRICT IP SAFEGUARD:**
    - Never use names of artists, movies, or brands.
    - Instead, describe the "Physicality" and "Material Logic" of the UI.

    **VISUAL EXECUTION RULES:**
    1. **Materiality**: Use physical metaphors to drive every CSS choice.
    2. **Typography**: Use high-quality web fonts (Inter, Geist, or system-ui). Pair a bold sans-serif with a refined monospace for data/labels.
    3. **Motion**: Include subtle, high-performance CSS animations (hover transitions, entry reveals, smooth staggered animations).
    4. **Layout**: Be bold with negative space and hierarchy. **AVOID GENERIC CARDS.** Use asymmetrical grids, suspended kinetic mobile elements, or fluid rectilinear structures.
    5. **Tailwind Only**: Output clean, accessible Tailwind CSS. For posters/logos, use absolute positioning, CSS grid, or SVG elements inline within the HTML. Ensure components are responsive.

    **OUTPUT FORMAT:**
    Return a JSON array of exactly 3 objects.
    Each object must have:
    - 'label': A unique design persona name based on a NEW physical metaphor.
    - 'html': The raw HTML string with Tailwind classes.
    - 'description': A one-sentence explanation describing the material logic and design persona.
  `.trim();

  const contents: string[] = [`Generate 3 design variations for: ${prompt}`];
  if (answers?.length > 0 && questions?.length > 0) {
    contents.push(`\n\nUser's answers to clarifying questions:\n${questions.map((q: string, i: number) => `Q: ${q}\nA: ${answers[i]}`).join('\n\n')}`);
  }
  const promptContent = contents.join('\n');

  const apiKey = process.env.GEMINI_API_KEY;

  if (apiKey) {
    try {
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: [promptContent],
        config: {
          systemInstruction,
          temperature: 1.0,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                label: { type: Type.STRING },
                html: { type: Type.STRING },
                description: { type: Type.STRING }
              },
              required: ['label', 'html', 'description']
            }
          }
        }
      });

      const jsonText = response.text;
      if (jsonText) {
        const usage = {
          promptTokenCount: response.usageMetadata?.promptTokenCount || 0,
          candidatesTokenCount: response.usageMetadata?.candidatesTokenCount || 0,
          totalTokenCount: response.usageMetadata?.totalTokenCount || 0
        };
        const parsedData = JSON.parse(jsonText.trim());
        const variants = parsedData.map((v: any, i: number) => ({ ...v, id: `variant-${Date.now()}-${i}` }));
        res.json({ data: variants, usage });
        return;
      }
    } catch (error) {
      console.warn('Primary Gemini API failed, attempting OpenRouter fallback...', error);
    }
  }

  try {
    const { text, usage } = await callOpenRouter(systemInstruction, promptContent, true);
    const cleaned = cleanJsonString(text);
    const parsedData = JSON.parse(cleaned);
    const rawVariants = Array.isArray(parsedData) ? parsedData : (parsedData.variants || parsedData.data || []);
    const variants = rawVariants.map((v: any, i: number) => ({ ...v, id: `variant-${Date.now()}-${i}` }));
    res.json({ data: variants, usage });
  } catch (err: any) {
    console.error('AI generation failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/modify-ui', async (req, res) => {
  const { currentHtml, prompt: userPrompt } = req.body;
  if (!currentHtml || !userPrompt) { res.status(400).json({ error: 'Missing currentHtml or prompt' }); return; }

  const sysInstruction = `You are an expert UI/UX developer and design master.`;
  const promptContent = `CURRENT HTML (Inner content of <body>):
${currentHtml}

USER REQUEST:
${userPrompt}

Task: Update the HTML based on the user request while maintaining high-fidelity design standards.
Rules:
1. Return ONLY the updated inner HTML that should go inside the <body> tag.
2. Do NOT include <html>, <head>, or <body> tags.
3. Use Tailwind CSS classes for all styling.
4. **IP SAFEGUARD**: Do not use brand or artist names.
5. **Material Logic**: Maintain the physical metaphors already present in the design or requested.
6. Return the raw HTML string only without markdown fences.`;

  const apiKey = process.env.GEMINI_API_KEY;

  if (apiKey) {
    try {
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `${sysInstruction}\n\n${promptContent}`,
        config: { temperature: 0.2 }
      });

      let html = response.text || '';
      html = html.replace(/```html\n?/g, '').replace(/```\n?/g, '');
      const usage = {
        promptTokenCount: response.usageMetadata?.promptTokenCount || 0,
        candidatesTokenCount: response.usageMetadata?.candidatesTokenCount || 0,
        totalTokenCount: response.usageMetadata?.totalTokenCount || 0
      };
      res.json({ data: html, usage });
      return;
    } catch (error) {
      console.warn('Primary Gemini API failed, attempting OpenRouter fallback...', error);
    }
  }

  try {
    const { text, usage } = await callOpenRouter(sysInstruction, promptContent, false);
    let html = text || '';
    html = html.replace(/```html\n?/g, '').replace(/```\n?/g, '');
    res.json({ data: html, usage });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/design-suggestions', async (req, res) => {
  const { currentHtml } = req.body;
  if (!currentHtml) { res.status(400).json({ error: 'Missing currentHtml' }); return; }

  const systemInstruction = `
    You are an expert design critic and UI/UX consultant.
    Analyze the provided HTML/Tailwind CSS code and suggest 3-4 specific improvements.
    Focus on: visual hierarchy, color harmony, typography, interaction design, consistency, mobile responsiveness.
    For each suggestion provide: title, description (the "why"), action (a specific command for an AI redesigner).
    Return a JSON array of objects.
  `.trim();

  const apiKey = process.env.GEMINI_API_KEY;

  if (apiKey) {
    try {
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Current HTML code:\n\n${currentHtml}`,
        config: {
          systemInstruction,
          temperature: 0.7,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                description: { type: Type.STRING },
                action: { type: Type.STRING }
              },
              required: ['title', 'description', 'action']
            }
          }
        }
      });

      const jsonText = response.text;
      if (jsonText) {
        const usage = {
          promptTokenCount: response.usageMetadata?.promptTokenCount || 0,
          candidatesTokenCount: response.usageMetadata?.candidatesTokenCount || 0,
          totalTokenCount: response.usageMetadata?.totalTokenCount || 0
        };
        const parsedData = JSON.parse(jsonText.trim());
        const suggestions = parsedData.map((s: any, i: number) => ({ ...s, id: `suggestion-${Date.now()}-${i}` }));
        res.json({ data: suggestions, usage });
        return;
      }
    } catch (error) {
      console.warn('Primary Gemini API failed, attempting OpenRouter fallback...', error);
    }
  }

  try {
    const { text, usage } = await callOpenRouter(systemInstruction, `Current HTML code:\n\n${currentHtml}`, true);
    const cleaned = cleanJsonString(text);
    const parsedData = JSON.parse(cleaned);
    const rawSuggestions = Array.isArray(parsedData) ? parsedData : (parsedData.suggestions || parsedData.data || []);
    const suggestions = rawSuggestions.map((s: any, i: number) => ({ ...s, id: `suggestion-${Date.now()}-${i}` }));
    res.json({ data: suggestions, usage });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/generate-vector', async (req, res) => {
  const { prompt: userPrompt } = req.body;
  if (!userPrompt) { res.status(400).json({ error: 'Missing prompt' }); return; }

  const systemInstruction = `
    You are an expert SVG artist and visual designer.
    Generate highly polished, modern, responsive raw SVG code based on the user's suggestion.
    Guidelines:
    1. Return ONLY the raw valid SVG string. No markdown blocks. Must start with "<svg" and end with "</svg>".
    2. Use viewBox, do NOT specify fixed width/height.
    3. Use stunning vector art: layered elements, glow effects, smooth paths, gradients.
    4. Safe: No external fonts or images.
  `.trim();

  const apiKey = process.env.GEMINI_API_KEY;

  if (apiKey) {
    try {
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Generate visual vector asset / illustration of: ${userPrompt}`,
        config: { systemInstruction, temperature: 0.8 }
      });

      let svg = response.text || '';
      svg = svg.replace(/```xml\n?/g, '').replace(/```html\n?/g, '').replace(/```\n?/g, '').trim();
      const usage = {
        promptTokenCount: response.usageMetadata?.promptTokenCount || 0,
        candidatesTokenCount: response.usageMetadata?.candidatesTokenCount || 0,
        totalTokenCount: response.usageMetadata?.totalTokenCount || 0
      };
      res.json({ data: svg, usage });
      return;
    } catch (error) {
      console.warn('Primary Gemini API failed for SVG, attempting fallback...', error);
    }
  }

  try {
    const { text, usage } = await callOpenRouter(systemInstruction, `Generate visual vector asset / illustration of: ${userPrompt}`, false);
    let svg = text || '';
    svg = svg.replace(/```xml\n?/g, '').replace(/```html\n?/g, '').replace(/```\n?/g, '').trim();
    res.json({ data: svg, usage });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/follow-up-questions', async (req, res) => {
  const { prompt: userPrompt } = req.body;
  if (!userPrompt) { res.status(400).json({ error: 'Missing prompt' }); return; }

  const systemInstruction = `
    You are an expert product manager and UX researcher.
    The user wants to build a design based on their prompt.
    Ask exactly 5 clarifying questions covering target audience, color scheme, features, typography, animations.
    Return a JSON array of exactly 5 strings.
  `.trim();

  const apiKey = process.env.GEMINI_API_KEY;

  if (apiKey) {
    try {
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `User prompt: ${userPrompt}`,
        config: {
          systemInstruction,
          temperature: 0.7,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: { type: Type.STRING }
          }
        }
      });

      const jsonText = response.text;
      if (jsonText) {
        const usage = {
          promptTokenCount: response.usageMetadata?.promptTokenCount || 0,
          candidatesTokenCount: response.usageMetadata?.candidatesTokenCount || 0,
          totalTokenCount: response.usageMetadata?.totalTokenCount || 0
        };
        res.json({ data: JSON.parse(jsonText.trim()), usage });
        return;
      }
    } catch (error) {
      console.warn('Primary Gemini API failed, attempting OpenRouter fallback...', error);
    }
  }

  try {
    const { text, usage } = await callOpenRouter(systemInstruction, `User prompt: ${userPrompt}`, true);
    const cleaned = cleanJsonString(text);
    res.json({ data: JSON.parse(cleaned), usage });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

async function startServer() {
  const vite = process.env.NODE_ENV !== 'production'
    ? await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      })
    : null;

  // Serve Vite pages in development, compiled build output assets in production
  if (vite) {
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Bind to port 3000 as required on the container structure
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on Port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start full-stack server:', err);
});
