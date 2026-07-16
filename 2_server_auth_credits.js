// ============================================================
// FARUMA — server-side auth + credit gating
// Drop this into your Express app (or require it as a module).
//
// Install:   npm install @supabase/supabase-js
//
// Railway environment variables to add (alongside ANTHROPIC_API_KEY):
//   SUPABASE_URL              e.g. https://abcd1234.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY (Dashboard > Settings > API — the SECRET one,
//                              never ship this to the browser)
// ============================================================

const { createClient } = require("@supabase/supabase-js");

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// ------------------------------------------------------------
// Credit price list — mirror of the plan we agreed.
// Keep this server-side ONLY; the front end just displays it.
// ------------------------------------------------------------
const CREDIT_COSTS = {
  lesson_plan: 1,
  assessment_worksheet: 1,
  assessment_quiz: 1,
  assessment_exit_ticket: 1,
  assessment_rubric: 2,
  assessment_project: 2,
  sow: 2,
  homework: 1,
  checklist: 1,
};
const ATTACHMENT_SURCHARGE = 1;

function creditsFor(generationType, hasAttachments) {
  const base = CREDIT_COSTS[generationType];
  if (base === undefined) return null; // unknown type -> reject
  return base + (hasAttachments ? ATTACHMENT_SURCHARGE : 0);
}

// ------------------------------------------------------------
// Middleware 1: verify the Supabase JWT on every protected route.
// The browser sends: Authorization: Bearer <access_token>
// ------------------------------------------------------------
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: "AUTH_REQUIRED" });
    }

    // Verifies signature + expiry against your Supabase project.
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ error: "AUTH_INVALID" });
    }

    req.user = data.user; // { id, email, ... } — trusted from here on
    next();
  } catch (err) {
    console.error("Auth check failed:", err);
    res.status(500).json({ error: "AUTH_CHECK_FAILED" });
  }
}

// ------------------------------------------------------------
// Middleware 2: reserve credits BEFORE the Claude call.
// Pattern: deduct up front (atomic, no double-spend), refund on failure.
// This is safer than deduct-after-success, where two concurrent
// requests could both pass a balance check.
// ------------------------------------------------------------
function reserveCredits() {
  return async (req, res, next) => {
    const generationType = req.body?.generationType;
    const hasAttachments = Boolean(req.body?.hasAttachments);

    const cost = creditsFor(generationType, hasAttachments);
    if (cost === null) {
      return res.status(400).json({ error: "UNKNOWN_GENERATION_TYPE" });
    }

    const { data: newBalance, error } = await supabaseAdmin.rpc("deduct_credits", {
      p_user_id: req.user.id,
      p_amount: cost,
      p_reason: generationType + (hasAttachments ? "+attachment" : ""),
    });

    if (error) {
      if (error.message.includes("INSUFFICIENT_CREDITS")) {
        return res.status(402).json({ error: "INSUFFICIENT_CREDITS" });
      }
      console.error("Credit reserve failed:", error);
      return res.status(500).json({ error: "CREDIT_CHECK_FAILED" });
    }

    req.credits = { cost, balanceAfter: newBalance, reason: generationType };
    next();
  };
}

// Refund helper — call in your catch blocks / on non-recoverable API errors.
async function refundCredits(userId, cost, reason) {
  const { error } = await supabaseAdmin.rpc("add_credits", {
    p_user_id: userId,
    p_amount: cost,
    p_reason: "refund:" + reason,
  });
  if (error) console.error("REFUND FAILED — manual fix needed:", userId, cost, error);
}

// ------------------------------------------------------------
// How to wire it into your EXISTING generation endpoint.
// Your current endpoint presumably looks something like:
//     app.post("/api/generate", async (req, res) => { ...call Claude... });
// It becomes:
// ------------------------------------------------------------
function attachCreditRoutes(app, callClaude /* your existing Claude-proxy fn */) {

  app.post("/api/generate", requireAuth, reserveCredits(), async (req, res) => {
    try {
      // Your existing logic, unchanged: prompt building, 45s AbortController
      // timeout, Overloaded retries, repairJson/safeJsonParse — all as-is.
      const result = await callClaude(req.body);

      res.json({
        ...result,
        credits: { spent: req.credits.cost, balance: req.credits.balanceAfter },
      });
    } catch (err) {
      // Generation failed after retries -> give the credits back.
      await refundCredits(req.user.id, req.credits.cost, req.credits.reason);
      console.error("Generation failed, credits refunded:", err);
      res.status(502).json({ error: "GENERATION_FAILED_CREDITS_REFUNDED" });
    }
  });

  // Balance endpoint for the UI header badge.
  app.get("/api/credits", requireAuth, async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from("profiles")
      .select("credit_balance")
      .eq("id", req.user.id)
      .single();
    if (error) return res.status(500).json({ error: "BALANCE_FETCH_FAILED" });
    res.json({ balance: data.credit_balance });
  });
}

module.exports = { requireAuth, reserveCredits, refundCredits, attachCreditRoutes, CREDIT_COSTS };
