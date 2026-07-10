#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const templatePath = path.join(root, "ui.template.html");
const mgPackagePath = path.join(root, "src", "ui", "mgPackage.js");
const packageValidationPath = path.join(root, "src", "ui", "packageValidation.js");
const uiPath = path.join(root, "ui.html");
const placeholder = "%%MASTERGO_MG_PACKAGE_JS%%";
const validationPlaceholder = "%%MASTERGO_PACKAGE_VALIDATION_JS%%";

const template = fs.readFileSync(templatePath, "utf8");
const mgPackage = fs.readFileSync(mgPackagePath, "utf8").trimEnd();
const packageValidation = fs.readFileSync(packageValidationPath, "utf8").trimEnd();

if (!template.includes(placeholder) || !template.includes(validationPlaceholder)) {
  throw new Error(`Missing ${placeholder} in ${templatePath}`);
}

const generated = template.replace(
  new RegExp(`^[ \\t]*${validationPlaceholder}$`, "m"),
  () => ["    // BEGIN generated v2 package validation", packageValidation, "    // END generated v2 package validation"].join("\n")
).replace(
  new RegExp(`^[ \\t]*${placeholder}$`, "m"),
  () => [
    "    // BEGIN generated MasterGo .mg package decoder",
    mgPackage,
    "    // END generated MasterGo .mg package decoder"
  ].join("\n")
);

fs.writeFileSync(uiPath, generated);
console.log(`Generated ${path.relative(process.cwd(), uiPath)}`);
