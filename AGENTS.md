# Diagram system rules

When creating or revising architecture and workflow diagrams in this repository:

- Match the visual system in `docs/images/gemini-model-flow.svg` and the reference diagram supplied by the user.
- Use a white 2048px-wide canvas with generous margins.
- Set titles in bold dark navy Arial. Add one thin light-gray divider below the title.
- On a 2048px-wide canvas, use approximately 48-52px for the title, 26-30px for box headings, 19-21px for supporting text, and 16-17px for arrow labels. Do not use smaller presentation text.
- Use uppercase, letter-spaced section labels in muted blue-gray.
- Draw square or lightly rounded boxes with 3px outlines. Do not use shadows, gradients, icons, or decorative shapes.
- Use gray outlines for inputs, outputs, storage, and neutral steps.
- Use teal outlines with a very pale teal fill only for active processing steps.
- Use amber only for search or user-action stages when those stages are present.
- Connect steps with dark blue-gray orthogonal lines and solid triangular arrowheads.
- Make the flow direction obvious from left to right. Branch only for real alternatives and visibly merge routes that produce the same output.
- Put a short bold noun phrase at the top of each box. Limit supporting copy to one or two short lines describing purpose or output.
- Label arrows only when the transferred object is not obvious. Use short uppercase labels such as `IMAGE + PROMPT`, `MASK`, or `SAVED COLORS`.
- Explain decisions inside the relevant box. Do not add detached paragraphs or a legend when direct labels are enough.
- Keep each diagram to one primary story. Remove implementation details that do not change how the viewer understands the flow.
- Verify that labels do not overlap, arrows do not cross text, branching is unambiguous, and the diagram remains readable when scaled down.
- Deliver both an editable SVG and a rendered PNG in `docs/images/`.
