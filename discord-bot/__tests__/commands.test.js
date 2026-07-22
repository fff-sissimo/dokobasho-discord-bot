const commands = require("../src/commands");

test("commands includes /image with prompt, purpose choices, and model choices", () => {
  const image = commands.find((command) => command.name === "image");

  expect(image).toBeDefined();
  expect(image.options).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "prompt", type: 3, required: true }),
    expect.objectContaining({
      name: "purpose",
      type: 3,
      required: false,
      choices: expect.arrayContaining([
        { name: "thumbnail", value: "thumbnail" },
        { name: "waiting_screen", value: "waiting_screen" },
        { name: "hp_visual", value: "hp_visual" },
        { name: "announcement", value: "announcement" },
        { name: "member_intro", value: "member_intro" },
        { name: "other", value: "other" },
      ]),
    }),
    expect.objectContaining({
      name: "model",
      type: 3,
      required: false,
      choices: expect.arrayContaining([
        { name: "fast", value: "fast" },
        { name: "standard", value: "standard" },
        { name: "high_quality", value: "high_quality" },
      ]),
    }),
  ]));
});

test("vc-memo start requires explicit recording consent", () => {
  const vcMemo = commands.find((command) => command.name === "vc-memo");
  const start = vcMemo.options.find((option) => option.name === "start");

  expect(start.options).toEqual(expect.arrayContaining([
    expect.objectContaining({
      name: "consent",
      type: 5,
      required: true,
    }),
  ]));
});
