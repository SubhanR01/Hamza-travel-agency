/**
 * Hamza Qurishi Tourism Company – flight price service (Cloudflare Worker)
 *
 * What it does: the website asks this worker for fares (e.g. KBL → IST on a date).
 * The worker asks the Travelpayouts / Aviasales Data API with YOUR secret token,
 * and returns a short list of fares. The token never appears in the website.
 *
 * Setup (see FLUGPREISE-EINRICHTEN.txt):
 *   1. Secret  TP_TOKEN        = your Travelpayouts API token
 *   2. Variable ALLOWED_ORIGIN = your website address, e.g. https://hamza-qurishi.com  (or * while testing)
 *   3. Optional  MARKUP_USD     = amount added to every fare (your service fee), e.g. 15
 */
export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || "*";
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=900"
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);
    const iata = v => /^[A-Z]{3}$/.test(v || "") ? v : null;
    const date = v => /^\d{4}-\d{2}(-\d{2})?$/.test(v || "") ? v : null;
    const from = iata(url.searchParams.get("origin"));
    const to = iata(url.searchParams.get("destination"));
    const depart = date(url.searchParams.get("depart"));
    const ret = date(url.searchParams.get("return"));
    if (!from || !to || !depart) {
      return new Response(JSON.stringify({ error: "origin, destination and depart (YYYY-MM-DD) are required" }), { status: 400, headers: cors });
    }

    const markup = Number(env.MARKUP_USD || 0);
    const api = new URL("https://api.travelpayouts.com/aviasales/v3/prices_for_dates");
    api.searchParams.set("origin", from);
    api.searchParams.set("destination", to);
    api.searchParams.set("departure_at", depart);
    if (ret) api.searchParams.set("return_at", ret);
    api.searchParams.set("one_way", ret ? "false" : "true");
    api.searchParams.set("currency", "usd");
    api.searchParams.set("sorting", "price");
    api.searchParams.set("limit", "10");

    const tryFetch = async u => {
      const r = await fetch(u, { headers: { "X-Access-Token": env.TP_TOKEN }, cf: { cacheTtl: 900 } });
      if (!r.ok) throw new Error("upstream " + r.status);
      return r.json();
    };

    try {
      let j = await tryFetch(api);
      // Nothing for the exact day? Fall back to the whole month.
      if ((!j.data || !j.data.length) && depart.length === 10) {
        api.searchParams.set("departure_at", depart.slice(0, 7));
        if (ret) api.searchParams.set("return_at", ret.slice(0, 7));
        j = await tryFetch(api);
      }
      const results = (j.data || []).slice(0, 6).map(f => ({
        airline: f.airline,
        flight_number: f.flight_number,
        departure_at: f.departure_at,
        return_at: f.return_at || "",
        transfers: f.transfers ?? 0,
        duration: f.duration_to || f.duration || 0,
        price: Math.round(f.price + markup)
      }));
      return new Response(JSON.stringify({ currency: "USD", results }), { headers: cors });
    } catch (e) {
      return new Response(JSON.stringify({ currency: "USD", results: [], error: "prices unavailable" }), { status: 200, headers: cors });
    }
  }
};
