describe("latex-tools item actions", () => {
  let list;

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    const pkg = await lumine.packages.activatePackage("latex-tools");
    list = pkg.mainModule.observedFilesList;
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("latex-tools");
  });

  it("derives its action from the command registration and the keymap", () => {
    const actions = list.selectList.itemActions();

    expect(actions.map((action) => action.command)).toEqual([
      "latex-tools:unobserve-selected-file",
    ]);
    const unobserve = actions[0];
    expect(unobserve.name).toBe("Unobserve Selected File");
    expect(unobserve.description).toBe(
      "Stop compiling the selected file on save and drop it from this list",
    );
    expect(unobserve.keystrokes).toEqual(["ctrl-d"]);
  });

  it("shows the actions as a flow step and runs one against the master list", async () => {
    list.show();

    await list.selectList.showItemActions();

    expect(list.selectList.itemActionsList.isVisible()).toBeTruthy();
    expect(lumine.workspace.getModalTrail()).toEqual(["Observed Files", "Actions"]);
    // The actions list wears the package class, so the package keymap
    // resolves action keystrokes inside it too.
    expect(
      list.selectList.itemActionsList.element.classList.contains("latex-tools-observed-files-list"),
    ).toBe(true);

    const spy = spyOn(list, "unobserveSelectedFile");
    const index = list.selectList.itemActionsList.items.findIndex(
      (item) => item.command === "latex-tools:unobserve-selected-file",
    );
    list.selectList.itemActionsList.selectIndex(index);
    list.selectList.itemActionsList.confirmSelection();

    expect(spy).toHaveBeenCalled();
    expect(list.selectList.isVisible()).toBeTruthy();
    expect(list.selectList.itemActionsList.isVisible()).toBeFalsy();
  });
});
