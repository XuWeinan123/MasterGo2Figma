#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const templatePath = path.join(root, "ui.template.html");
const mgPackagePath = path.join(root, "src", "ui", "mgPackage.js");
const packageValidationPath = path.join(root, "src", "ui", "packageValidation.js");
const uiPath = path.join(root, "ui.html");

// 1. Bundle the React app (ui-src/: shadcn components + import engine).
const bundle = esbuild.buildSync({
  entryPoints: [path.join(root, "ui-src", "main.tsx")],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2017",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  write: false,
  logLevel: "warning"
});
// "</script>" inside string literals would terminate the inline script tag.
const appJs = bundle.outputFiles[0].text.replace(/<\/script>/gi, "<\\/script>");

// 2. Compile Tailwind CSS for the app.
const cssOut = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "m2f-ui-")), "app.css");
execFileSync(process.execPath, [
  require.resolve("tailwindcss/lib/cli.js"),
  "-c", path.join(root, "tailwind.config.js"),
  "-i", path.join(root, "ui-src", "globals.css"),
  "-o", cssOut,
  "--minify"
], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
const appCss = fs.readFileSync(cssOut, "utf8");

// 3. Inline everything into the template.
const template = fs.readFileSync(templatePath, "utf8");
const mgPackage = fs.readFileSync(mgPackagePath, "utf8").trimEnd();
const packageValidation = fs.readFileSync(packageValidationPath, "utf8").trimEnd();

const replacements = {
  "%%APP_CSS%%": appCss,
  "%%MASTERGO_PACKAGE_VALIDATION_JS%%": [
    "// BEGIN generated v2 package validation",
    packageValidation,
    "// END generated v2 package validation"
  ].join("\n"),
  "%%MASTERGO_MG_PACKAGE_JS%%": [
    "// BEGIN generated MasterGo .mg package decoder",
    mgPackage,
    "// END generated MasterGo .mg package decoder"
  ].join("\n"),
  "%%APP_JS%%": appJs
};

let generated = template;
for (const placeholder in replacements) {
  if (!generated.includes(placeholder)) {
    throw new Error(`Missing ${placeholder} in ${templatePath}`);
  }
  generated = generated.replace(placeholder, () => replacements[placeholder]);
}

fs.writeFileSync(uiPath, generated);
console.log(`Generated ${path.relative(process.cwd(), uiPath)}`);
