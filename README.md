# latex-tools

Compile LaTeX documents with latexmk and view PDFs.

Includes SyncTeX support, compile-on-save, integrated linting, and multiple build management.

## Features

- **Compilation**: build documents using `latexmk` with configurable engines.
- **Compile-on-save**: automatically recompile when an observed file is saved.
- **PDF viewing**: open PDFs internally via [pdf-view](https://github.com/lumine-code/pdf-view) or in an external viewer.
- **SyncTeX**: forward and backward search between source and PDF.
- **Linter integration**: error and warning reporting via `linter.registry` with clickable references to source locations.
- **Multiple builds**: compile multiple files simultaneously with independent build states.
- **Magic comments**: per-file engine and root selection with `% !TEX program` and `% !TEX root`.

## Installation

To install `latex-tools` search for _latex-tools_ in the Install pane of the Lumine settings or run `lumine --install lumine-code/latex-tools`.

## Usage

This package requires `latexmk` and a LaTeX distribution to be installed on your system:

- **Windows**: [MiKTeX](https://miktex.org/download) (includes `latexmk`) or [TeX Live](https://www.tug.org/texlive/)
- **macOS**: [MacTeX](https://www.tug.org/mactex/) or `brew install --cask mactex`
- **Linux**: e.g. `sudo apt install texlive-full latexmk`

If `latexmk` is not in your PATH, set the full path in the package settings under **Path to latexmk**. The `latex-tools:global-rc` command opens your global `latexmkrc` file to customize `latexmk` behavior (e.g. glossaries support).

The status bar item shows the build state of the active file with a live timer (`TeX` idle, `TeX*` compile-on-save enabled; an eye icon with `TeX (N)` counts observed files). Left click compiles, alt-left click toggles compile-on-save, middle click splits PDF and TeX source, and right click interrupts the build and cleans auxiliary files. The item stays visible while viewing the output PDF, and opening a PDF during a build waits for completion before showing the updated file. Multi-file projects are supported: the build root is resolved from `% !TEX root` magic comments, `.fls` recorder files, or by scanning for documents that include the current file.

## Commands

Commands available in `atom-workspace`:

- `latex-tools:global-rc`: open the global `latexmkrc` configuration file (creates it if missing),
- `latex-tools:observed-files`: list files observed for compile-on-save,
- `latex-tools:clear-all-observed-files`: stop observing all compile-on-save files.

Commands available in `atom-text-editor[data-grammar~="latex"]`:

- `latex-tools:compile`: compile the current LaTeX document using `latexmk`,
- `latex-tools:toggle-compile-on-save`: toggle automatic compilation when the active file is saved,
- `latex-tools:interrupt`: stop the current build process for the active file,
- `latex-tools:interrupt-all`: stop all running build processes,
- `latex-tools:clean`: remove auxiliary files generated during compilation,
- `latex-tools:clean-linter`: clear all linter messages,
- `latex-tools:kill-and-clean`: interrupt the build and clean auxiliary files,
- `latex-tools:open-pdf`: open the generated PDF in Lumine,
- `latex-tools:synctex`: jump from source to corresponding PDF location (forward SyncTeX),
- `latex-tools:open-pdf-external`: open the generated PDF in an external viewer.

Commands available in `.latex-tools-observed-files-list`:

- `latex-tools:unobserve-selected-file`: stop observing the selected file.

## Customization

The status-bar item can be restyled from your `styles.less`, e.g.:

```less
.latex-tools-status {
  &.status-building {
    color: var(--text-color-info);
  }
}
```

## Services

- **latex-tools** (`1.0.0`): provided to let other packages drive LaTeX compilation — subscribe to build events (`onDidStartBuild`, `onDidFinishBuild`, `onDidFailBuild`, `onDidChangeBuildStatus`), query status (`getStatus`, `isBuilding`), control builds (`compile`, `interrupt`, `interruptAll`), and resolve SyncTeX positions (`syncToPdf`, `syncToSource`).
- **status-bar** (`^1.0.0`): consumed to show the build state, timer, and observed-files counter in the status bar.
- **open-external** (`^1.0.0`): consumed to open generated PDFs in an external viewer.
- **linter.registry** (`^1.0.0`): consumed to report LaTeX errors, warnings, and infos in the linter panel.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
