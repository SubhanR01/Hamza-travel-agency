/**
 * Hamza Qurishi Tourism Company – flight price service (Cloudflare Worker)
 *
 * Two modes:
 *  • LIVE  (recommended): set the secret DUFFEL_TOKEN. Prices come straight from the airlines
 *    at the moment of the search (Duffel API). Exact date, exact passengers, exact cabin.
 *  • DATA  (fallback): only TP_TOKEN set. Uses Travelpayouts/Aviasales saved fares, but ONLY
 *    for the exact date(s) searched – no nearby dates, nothing from other days.
 * If nothing matches, the answer is an empty list and the website says "No flights available".
 *
 * Settings (Worker → Settings → Variables and Secrets):
 *   DUFFEL_TOKEN   (Secret)  your Duffel live access token  – optional but gives exact live prices
 *   TP_TOKEN       (Secret)  your Travelpayouts API token    – used when no DUFFEL_TOKEN
 *   ALLOWED_ORIGIN (Text)    your website address, e.g. https://hamza-qurishi.pages.dev   (* while testing)
 *   MARKUP_USD     (Text)    optional service fee per person, e.g. 15
 */
export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: cors });

    const url = new URL(request.url);
    const p = k => url.searchParams.get(k) || "";
    const iata = v => /^[A-Z]{3}$/.test(v) ? v : null;
    const day = v => /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
    const from = iata(p("origin")), to = iata(p("destination"));
    const depart = day(p("depart")), ret = day(p("return"));
    const adults = Math.min(9, Math.max(1, parseInt(p("adults") || "1", 10) || 1));
    const cabin = p("cabin") === "business" ? "business" : "economy";
    if (!from || !to || !depart) return reply({ error: "origin, destination and depart (YYYY-MM-DD) are required" }, 400);
    const markup = Number(env.MARKUP_USD || 0);

    try {
      if (env.DUFFEL_TOKEN) {
        const slices = [{ origin: from, destination: to, departure_date: depart }];
        if (ret) slices.push({ origin: to, destination: from, departure_date: ret });
        const r = await fetch("https://api.duffel.com/air/offer_requests?return_offers=true&supplier_timeout=15000", {
          method: "POST",
          headers: { "Authorization": `Bearer ${env.DUFFEL_TOKEN}`, "Duffel-Version": "v2", "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify({ data: { slices, passengers: Array.from({ length: adults }, () => ({ type: "adult" })), cabin_class: cabin, max_connections: 2 } })
        });
        if (!r.ok) throw new Error("duffel " + r.status);
        const j = await r.json();
        const mins = iso => { const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/.exec(iso || ""); return m ? (+(m[1]||0))*1440 + (+(m[2]||0))*60 + (+(m[3]||0)) : 0; };
        const seen = new Set();
        const results = (j.data?.offers || [])
          .map(o => {
            const out = o.slices[0], back = o.slices[1], s0 = out.segments[0];
            return {
              airline: o.owner?.iata_code || s0.marketing_carrier?.iata_code,
              airline_name: o.owner?.name,
              flight_number: s0.marketing_carrier_flight_number,
              departure_at: s0.departing_at,
              return_at: back ? back.segments[0].departing_at : "",
              transfers: out.segments.length - 1,
              duration: mins(out.duration),
              price: Math.round(Number(o.total_amount) / adults + markup),
              currency: o.total_currency
            };
          })
          .filter(f => f.departure_at && f.departure_at.slice(0, 10) === depart)
          .sort((a, b) => a.price - b.price)
          .filter(f => { const k = f.airline + f.flight_number + f.departure_at; if (seen.has(k)) return false; seen.add(k); return true; })
          .slice(0, 6);
        return reply({ mode: "live", currency: results[0]?.currency || "USD", results });
      }

      // Data mode: exact dates only
      const api = new URL("https://api.travelpayouts.com/aviasales/v3/prices_for_dates");
      Object.entries({ origin: from, destination: to, departure_at: depart, currency: "usd", sorting: "price", limit: "30", one_way: ret ? "false" : "true" })
        .forEach(([k, v]) => api.searchParams.set(k, v));
      if (ret) api.searchParams.set("return_at", ret);
      const r = await fetch(api, { headers: { "X-Access-Token": env.TP_TOKEN } });
      if (!r.ok) throw new Error("travelpayouts " + r.status);
      const j = await r.json();
      const results = (j.data || [])
        .filter(f => String(f.departure_at).slice(0, 10) === depart && (!ret || String(f.return_at).slice(0, 10) === ret))
        .slice(0, 6)
        .map(f => ({ airline: f.airline, flight_number: f.flight_number, departure_at: f.departure_at, return_at: f.return_at || "",
                     transfers: f.transfers ?? 0, duration: f.duration_to || f.duration || 0, price: Math.round(f.price + markup) }));
      return reply({ mode: "data", currency: "USD", results });
    } catch (e) {
      return reply({ currency: "USD", results: [], error: "unavailable" });
    }
  }
};
