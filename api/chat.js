// Vercel Serverless Function — JASON Chat via Claude API
// Environment variable ANTHROPIC_API_KEY must be set in Vercel dashboard

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  try {
    const { messages, micSummary, sitesData, currentCart, currentPage } = req.body;

    const systemPrompt = buildSystemPrompt(micSummary, sitesData, currentCart, currentPage);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        messages: messages,
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error('Claude API error:', errorData);
      return res.status(response.status).json({ error: 'Claude API error', details: errorData });
    }

    const data = await response.json();
    const assistantMessage = data.content[0]?.text || 'No response from Claude.';

    // Parse any action commands from the response
    const actions = parseActions(assistantMessage);

    return res.status(200).json({
      message: assistantMessage,
      actions: actions,
    });

  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
}

function buildSystemPrompt(micSummary, sitesData, currentCart, currentPage) {
  return `You are JASON (Joint Automated Supply Ordering Network), an AI procurement agent for Alpha School, a K-12 microschool network using a 2 Hour Learning model.

## Your Role
You help the operations team (led by J.R. Houston, VP of Operations) procure school supplies, furniture (FFE), and construction materials. You are concise, action-oriented, and always suggest next steps.

## What You Can Do
- Help users build orders for specific school sites
- Answer questions about the MIC (Master Item Catalog) — prices, vendors, availability
- Provide MIC health analysis (missing prices, missing links, missing vendors)
- Suggest cost optimizations and vendor consolidation
- Guide users through the Order Builder workflow
- Calculate quantities based on site configurations (classrooms, students)

## Action Commands
When you want the UI to perform an action, include it in your response using this format:
[ACTION:navigate:order-builder] — Navigate to Order Builder page
[ACTION:navigate:mic] — Navigate to MIC page
[ACTION:navigate:sites] — Navigate to Sites page
[ACTION:navigate:orders] — Navigate to Orders page
[ACTION:navigate:dashboard] — Navigate to Dashboard
[ACTION:select-site:SITE_ID] — Select a specific site (PAL1, PIE1, ROS-001)
[ACTION:select-domain:DOMAIN] — Filter by domain (All, SUPPLIES, FFE, CONSTRUCTION)
[ACTION:select-all] — Select all items in current filter
[ACTION:clear-cart] — Clear the cart

You can include multiple actions. Always explain what you're doing before including actions.

## Current Context
- User is currently on: ${currentPage || 'dashboard'}
- Cart has: ${currentCart?.length || 0} items
${currentCart?.length > 0 ? `- Cart total: $${currentCart.reduce((s, i) => s + ((parseFloat(i.UNIT_PRICE) || 0) * i.quantity), 0).toFixed(2)}` : ''}

## MIC Summary
${micSummary || 'No MIC data available'}

## School Sites
${sitesData || 'No site data available'}

## Guidelines
- Be concise. J.R. is action-oriented and manages 10+ sites simultaneously.
- When someone says "order supplies for [site]", navigate them to Order Builder, select the site, filter to SUPPLIES, and suggest selecting all.
- Always mention specific numbers — item counts, costs, missing data counts.
- If asked about MIC health, break down by domain and highlight gaps.
- Format currency as $X,XXX.XX
- Use short paragraphs, not bullet points unless listing specific items.
- If you don't know something, say so and suggest where to find the answer.`;
}

function parseActions(message) {
  const actionRegex = /\[ACTION:(\w[\w-]*):?([\w-]*)\]/g;
  const actions = [];
  let match;
  while ((match = actionRegex.exec(message)) !== null) {
    actions.push({
      type: match[1],
      value: match[2] || null,
    });
  }
  return actions;
}
