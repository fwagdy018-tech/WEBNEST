import assert from "node:assert/strict";
import { test } from "node:test";
import { computeFills, DedupeIndex, identityKeys } from "../lib/dedupe";
import { normalizeAddress, normalizeName, normalizePhone, normalizeWebsite } from "../lib/normalize";

test("phone numbers normalize to E.164 regardless of formatting", () => {
  assert.equal(normalizePhone("(512) 555-0142", "US"), "+15125550142");
  assert.equal(normalizePhone("+1 512-555-0142", "US"), "+15125550142");
  assert.equal(normalizePhone("512.555.0142", "US"), "+15125550142");
  assert.equal(normalizePhone("(02) 9876 5432", "AU"), "+61298765432");
  assert.equal(normalizePhone("+61 2 9876 5432", "AU"), "+61298765432");
  assert.equal(normalizePhone("", "US"), "");
});

test("websites normalize to a domain key; shared platforms keep the path", () => {
  assert.equal(normalizeWebsite("https://www.JoesDetailing.com/home?utm=x"), "joesdetailing.com");
  assert.equal(normalizeWebsite("joesdetailing.com"), "joesdetailing.com");
  assert.equal(normalizeWebsite("http://m.joesdetailing.com/"), "joesdetailing.com");
  assert.equal(normalizeWebsite("https://www.facebook.com/JoesDetailing/"), "facebook.com/joesdetailing");
  assert.equal(normalizeWebsite("https://facebook.com/"), "");
  assert.equal(normalizeWebsite("not a url"), "");
});

test("names and addresses normalize common variations", () => {
  assert.equal(normalizeName("Joe's Auto Detailing, LLC"), normalizeName("Joes Auto Detailing"));
  assert.equal(normalizeName("Smith & Sons Inc."), "smith and sons");
  assert.equal(normalizeAddress("123 Main Street, Suite 4, Austin, TX 78701, USA"), normalizeAddress("123 Main St Ste 4, Austin TX 78701"));
});

test("index matches on phone, website, name+address, name+city+region", () => {
  const idx = new DedupeIndex<number>();
  idx.add(identityKeys({ "Business Name": "Shine Co", Phone: "(512) 555-0100", Country: "United States" }), 2);
  idx.add(identityKeys({ "Business Name": "Glow Nails", "Website URL": "https://glownails.com" }), 3);
  idx.add(identityKeys({ "Business Name": "Fade Masters", Address: "9 Oak Avenue, Dallas, TX 75201", City: "Dallas", "State / Province": "Texas" }), 4);

  assert.equal(idx.find(identityKeys({ "Business Name": "Other", Phone: "+1 512-555-0100", Country: "United States" }))?.ref, 2);
  const w = idx.find(identityKeys({ "Business Name": "Glow", "Website URL": "http://www.glownails.com/contact" }));
  assert.deepEqual([w?.ref, w?.matchedOn], [3, "website"]);
  assert.equal(idx.find(identityKeys({ "Business Name": "Fade Masters LLC", Address: "9 Oak Ave, Dallas, TX 75201" }))?.matchedOn, "nameAddress");
  assert.equal(idx.find(identityKeys({ "Business Name": "Fade Masters", City: "dallas", "State / Province": "TX" }))?.matchedOn, "nameCityRegion");
  assert.equal(idx.find(identityKeys({ "Business Name": "Brand New Place", City: "Austin", "State / Province": "TX" })), null);
});

test("computeFills only fills empty cells and never overwrites", () => {
  const existing = { "Business Name": "Shine (owner: Mike)", Email: "", Phone: "+1 512 555 0100", "Date Found": "2026-01-01", Rating: "" };
  const incoming = { "Business Name": "Shine Co", Email: "hi@shine.com", Phone: "", "Date Found": "2026-11-14", Rating: 4.6 };
  assert.deepEqual(computeFills(existing, incoming), { Email: "hi@shine.com", Rating: 4.6 });
});
