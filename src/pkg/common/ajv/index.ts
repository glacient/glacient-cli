import Ajv from "ajv";
import addFormats from "ajv-formats";

// Manifest schemas use draft-04 (`$schema: "http://json-schema.org/draft-04/schema#"`);
// ajv 8's bundled meta-schemas are draft-06/07. `validateSchema: false` skips the
// meta-schema lookup — the draft-04 features we use (`$ref`, `definitions`) compile
// fine under ajv's default draft-07 dialect.
export const ajv = new Ajv({ strict: false, validateSchema: false });
addFormats(ajv);
