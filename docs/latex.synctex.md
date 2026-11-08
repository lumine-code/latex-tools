# latex.synctex

Resolve positions between LaTeX source and its PDF using the configured SyncTeX executable.

| Metadata    | Value         |
| ----------- | ------------- |
| Version     | `1.0.0`       |
| Provided by | `latex-tools` |
| Consumed by | `pdf-view`    |

Declare `latex.synctex` in `consumedServices` and consume `^1.0.0`. The service exposes only the LaTeX synchronization operations:

```ts
interface LatexSynctex {
  syncToPdf(
    texPath: string,
    line: number,
    column?: number,
  ): Promise<{
    pdfPath: string;
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>;
  syncToSource(
    pdfPath: string,
    page: number,
    x: number,
    y: number,
  ): Promise<{
    file: string;
    line: number;
    column: number;
  } | null>;
}
```

Source lines, result pages and returned source positions are one-based. The optional forward column defaults to zero, which lets SyncTeX choose the line position. Forward lookup resolves the root document before locating its synchronization file. Missing synchronization data or a failed lookup returns `null`.

Return a `Disposable` from the consumer to drop the service reference when its provider disappears. An old service reference becomes inert after package deactivation.

Compilation belongs to the shared [`tasks` service](https://github.com/lumine-code/tasks/blob/master/docs/tasks.md). Use provider ID `latex-tools`; the Tasks service owns jobs, process termination, output, diagnostics, artifacts and observed files. The LaTeX provider resolves document roots, prepares latexmk arguments, parses the `.log` and supplies PDF artifacts. There is no separate LaTeX compilation service.

Additive changes remain in version `1.x`. A breaking contract change uses a new service name, with both provider and consumers migrating together.
