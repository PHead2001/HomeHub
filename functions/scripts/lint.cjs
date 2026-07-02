process.env.ESLINT_USE_FLAT_CONFIG = "false";
process.argv = ["node", "eslint", "--ext", ".js,.ts", "."];

require("../node_modules/eslint/bin/eslint.js");
