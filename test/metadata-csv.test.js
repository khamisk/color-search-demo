import assert from "node:assert/strict";
import test from "node:test";

import { parseMetadataCsv } from "../server.js";

test("CSV metadata supports the existing spreadsheet headers and quoted alt text", () => {
  const csv = [
    "Resource ID(s),Attribution,Scientific Name,Original filename,Alt Text DRAFT,Reviewed?",
    '6956,"Shedd, Aquarium",abudefduf saxatilis,fish.png,"Silver fish, with five stripes.",yes',
    '75111,,Acanthogorgia sp.,coral.png,"Branching coral with ""blueberry"" polyps\non pale branches.",0'
  ].join("\r\n");

  const metadata = parseMetadataCsv(csv);

  assert.equal(metadata.rowCount, 2);
  assert.deepEqual(metadata.byFilename.get("fish.png"), {
    resourceId: "6956",
    attribution: "Shedd, Aquarium",
    scientificName: "Abudefduf saxatilis",
    originalFilename: "fish.png",
    altTextDraft: "Silver fish, with five stripes.",
    reviewed: true
  });
  assert.equal(
    metadata.byFilename.get("coral.png").altTextDraft,
    'Branching coral with "blueberry" polyps on pale branches.'
  );
});

test("CSV metadata accepts UTF-8 BOM and simple filename/alt_text headers", () => {
  const csv = "\uFEFFfilename,alt_text\nfish.png,A bright orange fish\n\n";

  const metadata = parseMetadataCsv(csv);
  const fish = metadata.byFilename.get("fish.png");

  assert.equal(metadata.rowCount, 1);
  assert.equal(fish.originalFilename, "fish.png");
  assert.equal(fish.altTextDraft, "A bright orange fish");
  assert.equal(fish.resourceId, null);
  assert.equal(fish.reviewed, false);
});

test("CSV metadata requires a filename column", () => {
  assert.throws(
    () => parseMetadataCsv("alt_text,reviewed\nA fish,yes"),
    /must include an Original filename or filename column/
  );
});

test("CSV metadata reports unterminated quoted fields", () => {
  assert.throws(
    () => parseMetadataCsv('filename,alt_text\nfish.png,"A fish'),
    /unterminated quoted field/
  );
});
