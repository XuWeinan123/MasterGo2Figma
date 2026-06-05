# Python MG Converter

Convert a native MasterGo `.mg` export into a MasterGo2Figma v2 `.zip` package
that `ReceiveFromMasterGo` can import.

The Python CLI reuses the plugin decoder at
`ReceiveFromMasterGo/src/ui/mgPackage.js` so standalone conversion matches the
plugin import behavior.

## Usage

```bash
python3 pythonParser/mg_to_zip.py "插件测试_mg import problem 2.mg"
```

This writes:

```text
插件测试_mg import problem 2-mastergo2figma.zip
```

Use `-o` to choose an output path:

```bash
python3 pythonParser/mg_to_zip.py input.mg -o output.zip
```

## Requirements

- Python 3.9+
- Node.js available as `node`

Use `--node /path/to/node` or the `NODE` environment variable if Node is not on
`PATH`.
