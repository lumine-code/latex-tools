# latex-tools

Drives LaTeX compilation from another package: start and interrupt builds, read their status, follow build events, and resolve SyncTeX positions.

|             |                                                             |
| ----------- | ----------------------------------------------------------- |
| Version     | `1.0.0`                                                     |
| Provided by | `provideLatexTools()` returning the build service           |
| Consumed by | `consumeLatexTools(latexTools)`                             |
| Owner       | [`latex-tools`](https://github.com/lumine-code/latex-tools) |

Consumed by `pdf-view`, which uses it to keep the rendered PDF in step with the source and to jump between the two. The sibling service [`typst-tools`](https://lumine-code.github.io/docs.html#services/typst-tools) has a nearly identical shape.

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
  getOutputPath(filePath: string): string;
  resolveRoot(filePath: string): string;

  // Control
  compile(filePath: string): Promise<void>;
  interrupt(filePath: string): void;
  interruptAll(): void;
  setCompileOnSave(editor: TextEditor, enabled: boolean): void;
  isCompileOnSaveEnabled(editor: TextEditor): boolean;
};
```

| Group   | Notes                                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------------------------ |
| Events  | All return a `Disposable`. `onDidChangeBuildStatus` is the coarse one to drive an indicator from.                  |
| Status  | Every reader takes an **optional** `filePath`; omitting it answers for the whole project rather than one document. |
| Control | `compile` resolves when the build finishes. `interruptAll` stops every running build.                              |

## Minimal example

```js
const { CompositeDisposable, Disposable } = require("atom");

module.exports = {
  consumeLatexTools(latexTools) {
    this.latex = latexTools;
    const disposables = new CompositeDisposable();
    disposables.add(
      latexTools.onDidFinishBuild(({ filePath }) => {
        this.showPdf(latexTools.getOutputPath(filePath));
      }),
      new Disposable(() => (this.latex = null)),
    );
    return disposables;
  },
};
```

## Behavior

**`resolveRoot` is the one to reach for first.** A LaTeX project compiles from a root document, which is usually not the file the user is editing; passing the edited path to `compile` or `getOutputPath` without resolving the root first builds the wrong thing. `typst-tools` has no equivalent, which is the main difference between the two services.

`getOutputPath` answers from configuration, not from the filesystem — it is valid before a build has ever run, and does not imply the file exists.

`onDidFailBuild` and `onDidFinishBuild` are mutually exclusive per build; `onDidChangeBuildStatus` fires for both plus the transitions in between, so drive a status indicator from that one and act on the specific two.

Diagnostics reach the linter panel on their own — `latex-tools` registers an indie linter itself — so a consumer does not need to republish `getMessages`. Read them only if you are showing something the panel does not.

`compile` on a file already building is not queued; check `isBuilding(filePath)` first if that matters.

## Teardown

Return a `Disposable` that unsubscribes and drops your reference. Do **not** call `interruptAll` on teardown — it would stop builds the user started for their own reasons.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
