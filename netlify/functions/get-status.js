/**
 * Netlify Function: Get Application Status (Driver Portal)
 * POST /api/get-status
 *
 * Possession check: applicantId + email. Approved drivers only: anyone else
 * gets 403 pending_review and no token. On success, issues a driver JWT
 * ({ role: 'driver', driver_id }) and only the fields the portal shows.
 */

const { createClient } = require("@supabase/supabase-js");
const { serverError } = require("./_errors");
const { headers: corsHeaders } = require("./_cors");
const { issueDriverToken } = require("./_auth");
const { publicProfile, pendingReview } = require("./_driver-profile");

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const { applicantId, email } = body;

    if (!applicantId || !email) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "applicantId and email required" }),
      };
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const { data, error } = await supabase
      .from("applications")
      .select("*")
      .eq("id", applicantId)
      .eq("email", email.toLowerCase())
      .single();

    if (error || !data) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "Application not found" }) };
    }

    if (data.status !== "approved") return pendingReview(headers);

    const token = issueDriverToken(data.id);
    return { statusCode: 200, headers, body: JSON.stringify({ ...publicProfile(data), token }) };
  } catch (err) {
    return serverError(headers, err, "Failed to fetch status", "get-status");
  }
};
