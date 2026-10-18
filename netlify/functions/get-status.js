/**
 * Netlify Function: Get Application Status (Driver Portal)
 * POST /api/get-status
 *
 * Possession check: applicantId + email. On success, issues a driver JWT
 * ({ role: 'driver', driver_id }) for offer/GPS endpoints (#6).
 */

const { createClient } = require("@supabase/supabase-js");
const { serverError } = require("./_errors");
const { headers: corsHeaders } = require("./_cors");
const { issueDriverToken } = require("./_auth");

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
      .select("*, documents(*)")
      .eq("id", applicantId)
      .eq("email", email.toLowerCase())
      .single();

    if (error || !data) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "Application not found" }) };
    }

    const token = issueDriverToken(data.id);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ...data,
        name: `${data.first_name} ${data.last_name}`,
        dob: data.date_of_birth,
        vehicle_plate: data.license_plate,
        insurance_policy: data.insurance_policy_number,
        token,
      }),
    };
  } catch (err) {
    return serverError(headers, err, "Failed to fetch status", "get-status");
  }
};
