const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

function registerTypescript(root = path.resolve(__dirname, '../..')) {
  const originalResolveFilename = Module._resolveFilename;
  Module._resolveFilename = function resolveTypescriptImport(request, parent, isMain, options) {
    if (request.startsWith('@/')) {
      const absolute = path.join(root, 'src', request.slice(2));
      return originalResolveFilename.call(this, absolute, parent, isMain, options);
    }

    try {
      return originalResolveFilename.call(this, request, parent, isMain, options);
    } catch (error) {
      if ((request.startsWith('.') || request.startsWith('/')) && !path.extname(request)) {
        const base = request.startsWith('.')
          ? path.resolve(path.dirname(parent.filename), request)
          : request;
        for (const extension of ['.ts', '.tsx']) {
          if (fs.existsSync(`${base}${extension}`)) {
            return `${base}${extension}`;
          }
        }
      }
      throw error;
    }
  };

  require.extensions['.ts'] = function compileTypescript(module, filename) {
    const source = fs.readFileSync(filename, 'utf8');
    const output = ts.transpileModule(source, {
      compilerOptions: {
        esModuleInterop: true,
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        target: ts.ScriptTarget.ES2020,
      },
      fileName: filename,
    });
    module._compile(output.outputText, filename);
  };
}

module.exports = { registerTypescript };
