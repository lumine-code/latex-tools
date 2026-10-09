# latex-tools

Drives LaTeX compilation from another package: start and interrupt builds, read their status, follow build events, and resolve SyncTeX positions.

|             |                                                             |
| ----------- | ----------------------------------------------------------- |
| Version     | `1.0.0`                                                     |
| Provided by | `provideLatexTools()` returning the build service           |
| Consumed by | `consumeLatexTools(latexTools)`                             |
| Owner       | [`latex-tools`](https://github.com/lumine-code/latex-tools) |

Consumed by `pdf-view`, which uses it to keep the rendered PDF in step with the source and to jump between the two. The sibling service `typst-tools` has a nearly identical shape.

## Registration

In your `package.json`:

```json
{
  "consumedServices": {
    "latex-tools": {
      "versions": { "^1.0.0": "consumeLatexTools" }
    }
  }
}
```

## Contract

```ts
type LatexTools = {
  // Events
  onDidStartBuild(callback: (event: object) => void): Disposable;
  onDidFinishBuild(callback: (event: object) => void): Disposable;
  onDidFailBuild(callback: (event: object) => void): Disposable;
  onDidChangeBuildStatus(callback: (event: object) => void): Disposable;
  onDidUpdateMessages(callback: (event: object) => void): Disposable;
  onDidChangeCompileOnSave(callback: (event: object) => void): Disposable;

  // Status
  getStatus(filePath?: string): object;
  isBuilding(filePath: string): boolean;
  isAnyBuilding(): boolean;
  getMessages(filePath?: string): object[];
  getMessageStatistics(filePath?: string): object;
  getOutputPath(filePath: string): string | null;
  resolveRoot(filePath: string): string;

  // Control
  compile(filePath: string): boolean;
  interrupt(filePath: string): boolean;
  interruptAll(): number;
  setCompileOnSave(editor: TextEditor, enabled: boolean): boolean;
  isCompileOnSaveEnabled(editor: TextEditor): boolean;
  syncToPdf(texPath: string, line: number, column?: number): Promise<object | null>;
  syncToSource(pdfPath: string, page: number, x: number, y: number): Promise<object | null>;
};
```

| Group   | Notes                                                                                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Events  | All return a `Disposable`. `onDidChangeBuildStatus` is the coarse one to drive an indicator from.                                                                  |
| Status  | `getStatus()` reports all tracked builds. Omitting the path from diagnostic readers uses the active text editor.                                                   |
| Control | `compile` returns whether the build started; completion arrives through build events. `interruptAll` stops every running build and returns the number interrupted. |

## Minimal example

```js
const { CompositeDisposable, Disposable } = require("lumine");

module.exports = {
  consumeLatexTools(latexTools) {
    this.latex = latexTools;
    const disposables = new CompositeDisposable();
    disposables.add(
      latexTools.onDidFinishBuild(({ file }) => {
        const pdfPath = latexTools.getOutputPath(file);
        if (pdfPath) this.showPdf(pdfPath);
      }),
      new Disposable(() => (this.latex = null)),
    );
    return disposables;
  },
};
```

## Behavior

`resolveRoot` identifies the root document for an edited source file. `compile` and `getOutputPath` also resolve that root internally, so callers may pass a child source path directly. `typst-tools` has no equivalent root discovery.

`getOutputPath` resolves the build root and returns its PDF path only when the file exists; otherwise it returns `null`.

`onDidFailBuild` and `onDidFinishBuild` are mutually exclusive per build; `onDidChangeBuildStatus` fires for both plus the transitions in between, so drive a status indicator from that one and act on the specific two.

Diagnostics reach the linter panel on their own — `latex-tools` registers an indie linter itself — so a consumer does not need to republish `getMessages`. Read them only if you are showing something the panel does not.

`compile` on a file already building is not queued; check `isBuilding(filePath)` first if that matters.

## Teardown

Return a `Disposable` that unsubscribes and drops your reference. Do **not** call `interruptAll` on teardown — it would stop builds the user started for their own reasons.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
