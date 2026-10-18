/**
 * Service area: which towns we price, and which ZIPs belong to them.
 *
 * Towns = the hubs the price table knows (zones.js ZONES.hubs). The client
 * mirrors this list in frontend/js/coastal.js CITIES and the /order/ selects;
 * tests/town-zip-validation.test.js fails if they drift. (Not one shared file:
 * the site publishes frontend/ and functions bundle from netlify/functions/,
 * and a cross-directory require from a function is a deploy risk we can't
 * verify without a live deploy.)
 *
 * ZIP -> town data comes ONLY from the U.S. Census Bureau 2020 ZCTA-to-Place
 * relationship file:
 *   https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_place20_natl.txt
 *   (layout: https://www.census.gov/programs-surveys/geography/technical-documentation/records-layout/2020-zcta-record-layout.html)
 * ZCTAs approximate USPS ZIPs (https://www.census.gov/programs-surveys/geography/guidance/geo-areas/zctas.html).
 * Land area of each ZCTA inside each place, checked 2026-10-18:
 *   78373: Port Aransas city 8.74 sq mi, Corpus Christi city 9.20 (the annexed
 *          Mustang Island strip), Aransas Pass city 0.90 (Harbor Island /
 *          causeway area of that city), ZCTA land 18.85 -> Mustang Island / Port A.
 *          Treated as beach-only.
 *   78418: Corpus Christi city 29.88 + 43.47 unincorporated of 73.35. Covers
 *          Flour Bluff + NAS Corpus Christi on the MAINLAND and North Padre /
 *          south Mustang Island. AMBIGUOUS (beach and non-beach).
 *   78401 78402 78404-78417 78419: Corpus Christi city (non-beach).
 *          78415 is mostly rural outside city limits but is a Corpus Christi ZIP.
 *   78382: Rockport city 16.39, Fulton 0.58, Lamar/Holiday Beach CDPs (Rockport PO).
 * Not mapped (no ZCTA, or not one of our towns): PO-box-only ZIPs (e.g. 78403),
 * Fulton 78358, Aransas Pass 78336, Ingleside 78362, etc. Every ZCTA above is
 * 783xx/784xx; ZIPs outside those prefixes are outside the Coastal Bend.
 */
"use strict";
const { ZONES } = require("./zones");

const TOWNS = Object.keys(ZONES.hubs); // Port Aransas, Mustang Island, Padre Island, Corpus Christi, Rockport

const ZIP_TOWNS = {
  "78373": ["Port Aransas", "Mustang Island"],
  "78418": ["Padre Island", "Mustang Island", "Corpus Christi"], // ambiguous: islands + Flour Bluff mainland
  "78382": ["Rockport"],
};
["78401", "78402", "78404", "78405", "78406", "78407", "78408", "78409", "78410", "78411", "78412", "78413", "78414", "78415", "78416", "78417", "78419"]
  .forEach((z) => { ZIP_TOWNS[z] = ["Corpus Christi"]; });

const AMBIGUOUS_ZIPS = ["78418"];
// Which priced town each answer means for an ambiguous ZIP.
const ZIP_AREAS = { "78418": { island: "Padre Island", mainland: "Corpus Christi" } };
const ZIP_AREA_VALUES = ["island", "mainland"];
const REGION_PREFIXES = ["783", "784"];

function isBeachTown(t) { return ZONES.beachCities.includes(t); }
function zip5(z) { const m = /^(\d{5})/.exec(String(z == null ? "" : z).trim()); return m ? m[1] : null; }
function townList(conj) { return TOWNS.slice(0, -1).join(", ") + " " + (conj || "and") + " " + TOWNS[TOWNS.length - 1]; }

/**
 * Check one end of a trip. Returns:
 *   { ok: false, status, code, field, error }       -> refuse the order
 *   { ok: true, town, zip, priceTown, flag?, note? } -> accept (priceTown = town we
 *                                                       price/dispatch as; flag = address
 *                                                       check for dispatch; note = info)
 * Rules (safest for the customer first):
 *   - unknown town                       -> 400 unknown_town
 *   - ZIP outside 783xx/784xx            -> 400 zip_outside_area
 *   - ZIP only maps to beach towns, non-beach town picked -> 400 zip_town_mismatch
 *       (refuse rather than silently re-price: the customer sees the right quote
 *        before paying, and the order gets a 4x4)
 *   - ambiguous ZIP (78418) with a non-beach town -> the customer must say which
 *       side it is: body.<end>_zip_area = "island" | "mainland".
 *         missing/other -> 400 zip_area_required (the order page turns it into
 *                          a question on the Review step, before payment)
 *         "island"      -> priced AND dispatched as Padre Island (beach
 *                          surcharge + 4x4), whatever town was picked
 *         "mainland"    -> Corpus Christi pricing, normal vehicle (Flour Bluff)
 *       The client asks the same question first (frontend/js/coastal.js
 *       zipAreaQuestion) so the quote they confirm matches what we charge.
 *   - ZIP in the region but not mapped, or a beach town with another beach town's
 *       ZIP -> accept + flag (no price downgrade possible)
 */
function checkEnd(townRaw, zipRaw, field, areaRaw) {
  const town = String(townRaw == null ? "" : townRaw).trim();
  const label = field === "dropoff" ? "drop-off" : "pickup";
  if (!TOWNS.includes(town)) {
    return { ok: false, status: 400, code: "unknown_town", field: field + "_city",
      error: `We don't serve "${town.slice(0, 40)}" yet. Choose a ${label} town: ${townList("or")}.` };
  }
  const zip = zip5(zipRaw);
  if (!zip) return { ok: true, town, zip: null, priceTown: town };
  if (!REGION_PREFIXES.includes(zip.slice(0, 3))) {
    return { ok: false, status: 400, code: "zip_outside_area", field: field + "_zip",
      error: `ZIP ${zip} is outside our service area. We serve ${townList()}. Please check the ${label} ZIP.` };
  }
  const towns = ZIP_TOWNS[zip];
  if (!towns) return { ok: true, town, zip, priceTown: town, flag: `${label} ZIP ${zip} isn't mapped to ${town}; please confirm the address.` };
  if (towns.includes(town)) {
    if (AMBIGUOUS_ZIPS.includes(zip) && !isBeachTown(town)) {
      const area = String(areaRaw == null ? "" : areaRaw).trim().toLowerCase();
      const sides = ZIP_AREAS[zip];
      if (!ZIP_AREA_VALUES.includes(area)) {
        return { ok: false, status: 400, code: "zip_area_required", field: field + "_zip_area", zip,
          error: `ZIP ${zip} covers both ${sides.island} and ${sides.mainland === "Corpus Christi" ? "Flour Bluff (mainland Corpus Christi)" : sides.mainland}. Tell us which one your ${label} is on so we can price it correctly.` };
      }
      if (area === "island") {
        return { ok: true, town, zip, priceTown: sides.island, area,
          note: `Customer picked ${town}, ${label} ZIP ${zip}, and said it is on ${sides.island}; priced and dispatched as ${sides.island}.` };
      }
      return { ok: true, town, zip, priceTown: town, area,
        note: `Customer said the ${label} (ZIP ${zip}) is in Flour Bluff / mainland ${town}.` };
    }
    return { ok: true, town, zip, priceTown: town };
  }
  const allBeach = towns.every(isBeachTown);
  if (allBeach && !isBeachTown(town)) {
    return { ok: false, status: 400, code: "zip_town_mismatch", field: field + "_city",
      error: `ZIP ${zip} is on the island (${towns.join(" / ")}), but the ${label} town is ${town}. Go back to the Route step and pick ${towns.join(" or ")} so we price beach access and send a 4x4.` };
  }
  return { ok: true, town, zip, priceTown: town, flag: `${label} ZIP ${zip} is usually ${towns.join(" / ")}, but ${town} was picked; please confirm the address.` };
}

function checkTrip(body) {
  const pickup = checkEnd(body.pickup_city, body.pickup_zip, "pickup", body.pickup_zip_area);
  if (!pickup.ok) return pickup;
  const hasDrop = body.dropoff_city != null && String(body.dropoff_city).trim() !== "";
  const dropoff = hasDrop
    ? checkEnd(body.dropoff_city, body.dropoff_zip, "dropoff", body.dropoff_zip_area)
    : checkEnd(body.pickup_city, body.dropoff_zip || null, "dropoff", body.dropoff_zip_area);
  if (!dropoff.ok) return dropoff;
  const flags = [pickup.flag, dropoff.flag].filter(Boolean);
  const notes = [pickup.note, dropoff.note].filter(Boolean);
  // No dropoff given = same place as pickup (create-order's existing rule).
  const dropoffPriceTown = hasDrop ? dropoff.priceTown : pickup.priceTown;
  return { ok: true, pickupTown: pickup.priceTown, dropoffTown: dropoffPriceTown, flags, notes };
}

module.exports = { TOWNS, ZIP_TOWNS, AMBIGUOUS_ZIPS, ZIP_AREAS, ZIP_AREA_VALUES, REGION_PREFIXES, checkEnd, checkTrip, zip5 };
