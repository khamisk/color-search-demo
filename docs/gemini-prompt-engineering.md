# Engineering the Gemini Cutout Prompt

This document explains how the Gemini background-removal prompt was shaped, what problems each part solves, and why the current result depends on both prompt design and deterministic image post-processing.

> **History note:** The production prompt entered the repository as one block, so there is no commit-by-commit prompt history to recover. The intermediate prompts below are illustrative reconstructions based on the failure modes documented in the project and visible in the current implementation. They show the reasoning path; they are not presented as verbatim historical prompts.

## Presentation-ready narrative

This section follows the requested presentation structure: considerations, design outcomes, working backward from those outcomes, three prompt versions, and a breakdown of the final version. It is written so it can be read almost word for word.

### 1. What were we trying to build?

> We needed to remove the background from aquarium animal images so each animal could be displayed cleanly and used for color search.
>
> The goal was not simply to produce an image that looked good. The cutout also needed to work as an accurate mask so the application could identify which pixels belonged to the organism.

### 2. Design outcomes and considerations

A design outcome describes what the final result must accomplish. A consideration is a risk or technical limitation that influenced how we built it.

| Desired design outcome | Consideration |
| --- | --- |
| Preserve the complete organism | Fine structures such as fins, coral branches, tentacles, hair, and legs could disappear during background removal. |
| Maintain the original appearance | A generative model might smooth, recolor, relight, simplify, or reconstruct the organism. |
| Remove all background content | Water, rock, sand, aquarium glass, labels, and shadows can be difficult to separate from the organism. |
| Avoid cropping | The model might reframe the image or cut off fins, tails, legs, antennae, or coral tips. |
| Produce usable transparency | The image API may return an opaque image instead of dependable alpha transparency. |
| Preserve accurate searchable colors | A generated cutout may shift colors slightly, even when its shape is useful. |

### 3. How we worked backward from the outcome

> We worked backward from the final color-search experience.
>
> Reliable search required accurate colors. Accurate colors required knowing which pixels belonged to the animal. That required a reliable subject mask. The background-removed image became that mask.
>
> Because the cutout was being used as a mask, preserving the organism's exact shape and fine details was more important than making the generated image look polished. That led us to make the prompt increasingly specific about preservation, cropping, prohibited changes, background content, and the handoff to image-processing code.

The reasoning chain was:

```text
Reliable color search
  -> accurate colors
  -> accurate subject mask
  -> complete and faithful cutout
  -> explicit prompt requirements
  -> deterministic post-processing
```

### 4. Prompt version 1: basic instruction

This is an approximate reconstruction, not a verbatim historical prompt.

```text
Remove the background from this image.
```

This version described the action, but not the intended result. It did not explain what needed to survive, what counted as background, whether the model could alter the subject, how the subject should be framed, or what output format the application needed.

Likely problems included:

- fine anatomy disappearing with the background;
- aquarium scenery remaining around the organism;
- the organism being cropped or reframed;
- the model returning a polished reinterpretation instead of a faithful cutout; and
- an opaque result instead of usable transparency.

**Learning:** Saying what to remove was not enough. We also needed to say what must survive.

### 5. Prompt version 2: preservation and transparency

This is also an approximate reconstruction. It combines a few intermediate ideas into one readable version.

```text
Remove the background and return a transparent cutout.
Preserve the entire animal and all fine details.
Do not crop the animal.
```

This version introduced the desired output, subject preservation, and framing. However, phrases such as "fine details" were still too general. The model might not interpret a translucent fin, thin coral branch, tentacle, hair, or shell edge as an essential detail.

It also left several behaviors unconstrained:

- smoothing or beautifying texture;
- relighting or recoloring the organism;
- reconstructing missing anatomy;
- retaining aquarium-specific background objects; and
- returning an opaque background with gradients or shadows.

**Learning:** We needed to name fragile structures, prohibit unwanted generative changes, define aquarium background content, and create a predictable fallback when transparency was unavailable.

### 6. Prompt version 3: final version

This is the prompt currently used by the application:

```text
Remove the background from this animal, coral, fish, reptile, or invertebrate image.
Return one transparent PNG cutout of only the visible organism.
Preserve the full organism exactly: all branches, fins, tentacles, legs, hair, shell, texture, markings, translucency, and natural color.
Do not crop the organism. Leave a small transparent margin around the complete subject.
Do not blur, smooth, relight, recolor, stylize, simplify, add shadows, or reconstruct missing detail.
Remove only non-organism background such as water, rock, sand, substrate, aquarium glass, scenery, labels, shadows, backdrops, or watermark text.
The area outside the organism must be a flat pure #FFFFFF background with no gray reconstruction, shadows, texture, or scenery.
```

### 7. Breakdown of the final prompt

Each part of the final prompt addresses a consideration identified earlier.

| Final prompt section | Consideration it addresses | Intended outcome |
| --- | --- | --- |
| "animal, coral, fish, reptile, or invertebrate" | Unusual organisms can be mistaken for scenery. | Establish the complete subject domain. |
| "one ... cutout of only the visible organism" | The model could return a redesigned scene or invent anatomy outside the image. | Define one limited, faithful deliverable. |
| Explicit branches, fins, tentacles, legs, hair, shell, texture, markings, and translucency list | Fragile structures and soft edges can disappear. | Preserve the complete organism. |
| "Do not crop" and the small-margin requirement | Automatic reframing can clip anatomy. | Keep the complete subject safely inside the frame. |
| No blur, smoothing, relighting, recoloring, stylizing, simplifying, shadows, or reconstruction | Generative editing can change the organism while still producing a convincing image. | Maintain fidelity to the source. |
| Aquarium-specific removal list | Generic "background" language is ambiguous in aquarium photography. | Remove water, rock, substrate, glass, labels, and other non-organism content. |
| Flat pure-white outside area | Real alpha transparency is not always returned, and textured off-white backgrounds are difficult to remove safely. | Give downstream code a predictable fallback matte. |

### 8. Final design outcome

> The final solution is not only a prompt. It is a contract between the prompt and the image-processing code.
>
> If Gemini returns real transparency, the application keeps it. If Gemini returns an opaque image, the pure-white requirement gives the application a predictable background that can be removed programmatically.
>
> The cutout is then used primarily as a mask. Searchable colors are sampled from the original image so that color changes introduced by Gemini have less effect on search accuracy.

### 9. Closing takeaway

> The prompt improved because every new section addressed a specific observed failure. The solution did not improve simply because the prompt became longer.

When presenting the earlier versions, disclose that they are approximate reconstructions:

> The first two prompts are rough reconstructions based on the problems we encountered. The third prompt is the final version currently used in the application.

---

## Detailed engineering reference

### Executive summary

The task sounds simple: remove an image background. For this demo, however, success means much more than producing a visually clean image. The output must:

- keep the complete animal or organism, including fragile edges and fine anatomy;
- preserve the source appearance instead of generating a prettier interpretation;
- remove aquarium scenery, text, shadows, and other non-subject content;
- keep the subject uncropped with a small margin; and
- provide a background that code can reliably turn into transparency.

The current prompt works because it specifies all five requirements. It defines what to keep, what to remove, what edits are forbidden, how the subject should be framed, and what the outside area should look like. The rest of the pipeline then checks the result and converts Gemini's usually white matte into a transparent PNG.

The important lesson is that this is not prompt magic. It is a prompt-and-code contract.

### The current prompt

The production prompt lives in `removeBackgroundWithGemini()` in [`server.js`](../server.js):

```text
Remove the background from this animal, coral, fish, reptile, or invertebrate image.
Return one transparent PNG cutout of only the visible organism.
Preserve the full organism exactly: all branches, fins, tentacles, legs, hair, shell, texture, markings, translucency, and natural color.
Do not crop the organism. Leave a small transparent margin around the complete subject.
Do not blur, smooth, relight, recolor, stylize, simplify, add shadows, or reconstruct missing detail.
Remove only non-organism background such as water, rock, sand, substrate, aquarium glass, scenery, labels, shadows, backdrops, or watermark text.
The area outside the organism must be a flat pure #FFFFFF background with no gray reconstruction, shadows, texture, or scenery.
```

### Why each clause is there

| Prompt clause | Its job | Failure it prevents |
| --- | --- | --- |
| "animal, coral, fish, reptile, or invertebrate" | Establishes the full subject domain. | Treating coral, shells, tentacles, or unusual body shapes as scenery. |
| "one ... cutout of only the visible organism" | Defines a single deliverable and limits the output to visible subject matter. | Returning a redesigned scene, a comparison image, or invented anatomy outside the frame. |
| "Preserve ... branches, fins, tentacles..." | Creates a positive preservation contract, naming the features most likely to disappear. | Erasing thin coral branches, translucent fins, hair, legs, markings, or shell texture. |
| "Do not crop ... small ... margin" | Separates subject segmentation from composition. | Tight crops that clip fins, antennae, tails, or coral tips. |
| "Do not blur, smooth, relight..." | Blocks common generative-image behavior. | Beautification, color drift, plastic-looking texture, invented edges, or reconstructed missing parts. |
| "Remove only non-organism background such as..." | Gives Gemini a domain-specific background taxonomy. | Keeping water, aquarium glass, rock, substrate, labels, shadows, or watermarks because they seem contextually related. |
| "flat pure `#FFFFFF`" | Makes a failed-alpha result predictable and machine-detectable. | Off-white, gray, textured, shadowed, or regenerated backgrounds that are difficult to key out safely. |

The ordering gives the model task and output context first, then preservation and framing requirements, then prohibited edits, and finally the background/matte constraint. This makes the instruction easier to read as one edit specification rather than as an unstructured list of negatives.

### Reconstructed iteration path

#### Iteration 0: local background removal

Before the Gemini path, the first local approach was too aggressive on detailed organisms. Coral branches, soft edges, and fine animal detail could be washed out or removed. That established the key product requirement: a clean silhouette is not a success if biological detail is lost.

The intended advantage of moving to an image-editing model was better semantic separation of organism and habitat. It also introduced generative behavior that had to be constrained.

#### Iteration 1: the one-line instruction

```text
Remove the background from this image.
```

This identifies the action but leaves almost every important decision to the model. "Background" is ambiguous in aquarium photography: rock may touch a coral, water can show through translucent fins, and substrate may share the animal's color. It also says nothing about cropping, fidelity, output format, or whether the model may repair the subject.

Representative failures:

- thin anatomy disappears with the background;
- rock or water remains near the subject boundary;
- the subject is recentered or tightly cropped; and
- the model returns a cleaned-up image rather than a faithful cutout.

**Lesson:** State the preservation goal, not just the removal action.

#### Iteration 2: ask for transparency and preservation

```text
Remove the background and return a transparent cutout. Preserve the entire animal and all fine details. Do not crop it.
```

This improves completeness and framing, but "fine details" is still abstract. The model may not treat a coral branch, translucent fin, tentacle, hair, or shell edge as the detail we mean. The prompt also leaves generative cleanup behavior unconstrained: it can smooth texture, relight the subject, or reconstruct an occluded edge while technically preserving the "animal."

Transparency was also not dependable. The current API call requests JPEG output, which cannot carry alpha, and image models may return an opaque white or near-white canvas even when transparency is requested.

**Lesson:** Name fragile structures explicitly, forbid unwanted transformations, and design for the output format actually returned by the API.

#### Iteration 3: define what must survive and what must go

```text
Preserve all branches, fins, tentacles, legs, hair, shell, texture, markings, translucency, and natural color. Do not crop, blur, smooth, relight, recolor, stylize, simplify, or reconstruct the subject. Remove water, rock, sand, substrate, aquarium glass, scenery, labels, shadows, backdrops, and watermark text.
```

This is much closer to the final behavior. It defines subject membership from both directions:

- a positive list tells the model what belongs to the organism; and
- a negative list tells it what counts as aquarium background.

The remaining problem is the handoff to software. A visually plain background can still contain gradients, compression noise, a soft shadow, or reconstructed scenery. Those variations make automatic transparency removal risky, especially when the organism itself is white.

**Lesson:** The model output needs a deterministic intermediate state, not merely a visually acceptable background.

#### Iteration 4: the current prompt and the white-matte contract

The final version adds two output ideas:

1. ask for the desired product--a transparent cutout; and
2. require any outside area to be flat pure white with no texture or shadow.

Read in isolation, "transparent PNG" and "pure `#FFFFFF` background" appear contradictory. In the current pipeline, they form a resilient two-path contract:

- if Gemini returns useful alpha, the app keeps it;
- if Gemini returns an opaque result, pure white gives the app a predictable matte to remove.

Because the API currently requests JPEG, the second path is the normal one. In the local cache snapshot checked on July 15, 2026, 21 of the 22 Gemini entries with transparency tracking were stored as `post-processed-white-edge`; one was recorded as `opaque-output`. That makes the white background a core part of the design, not an unusual fallback.

**Lesson:** Prompt for the ideal output, but also constrain the most likely fallback into a form that deterministic code can validate and repair.

### The prompt is only half of the solution

The end-to-end flow is:

```text
source image
  -> normalize to PNG, at most 1600 x 1600
  -> send prompt + image to Gemini
  -> request a 1K image at the closest supported aspect ratio
  -> inspect returned pixels
       -> keep native transparency, or
       -> convert a flat white matte to alpha, or
       -> flag/store an opaque result
  -> save a normalized PNG plus its transparency state
  -> use the cutout as a mask over the original image for color extraction
```

Several implementation details make the prompt robust:

- Gemini has no JSON schema or text parser in this path. Its formal response contract is an image response, while the postconditions are checked at the pixel level.
- `prepareCutoutForStorage()` converts the result to PNG and measures transparency and border whiteness.
- Native transparency is accepted when more than 1% of the output is transparent.
- A mostly white border triggers `removeWhiteEdgeMatte()`, which starts from edge-connected white pixels.
- The cleanup compares remaining near-white candidates against the original source, which helps protect interior white animal detail while generated white background is removed.
- Post-processing-generated matte masks that would make less than 2% or more than 96.5% of the image transparent are rejected instead of silently destroying the subject.
- Color extraction reconciles colors from the generated cutout with original-source colors sampled through the generated mask. This limits, but cannot completely eliminate, the effect of any color shift introduced by Gemini.

The regression test in [`test/image-processing.test.js`](../test/image-processing.test.js) specifically checks that white matte is removed without erasing real white detail inside the animal.

Three current images illustrate the edge cases behind these rules:

- The Blueberry gorgonian has a dense network of fine branches and polyps, making it a representative case for the explicit branch, texture, and no-simplification language.
- The Doctorfish has substantial white and silver body detail, making it a useful case for source-aware white-matte cleanup.
- The Pacific false coral fills almost the entire frame and is recorded as `opaque-output`; there is very little obvious background to separate. It is a reminder that a constrained prompt can expose an ambiguous input, but cannot always resolve it.

### Problems encountered and the corresponding guardrails

| Problem | Prompt guardrail | Code guardrail |
| --- | --- | --- |
| Fine structures removed | Explicit branches, fins, tentacles, legs, hair, shell, texture, and translucency list | Use the detailed model for harder cases and retain QA/reprocessing controls. |
| Subject clipped | "Do not crop" plus a small margin | Request the closest supported source aspect ratio to reduce reframing risk. |
| Subject beautified or changed | Explicit no-blur, no-relight, no-recolor, no-stylize, no-reconstruction list | Reconcile cutout colors with original-source colors sampled through the mask. |
| Aquarium context retained | Domain-specific removal list | No automatic semantic detector; manual QA or reprocessing is still required. |
| Gray halo or regenerated background | Flat pure-white requirement with no shadow, texture, or scenery | Strict and near-white pixel tests plus edge-connected matte removal. |
| JPEG returned without alpha | White-matte fallback | Convert the returned image to PNG and create alpha locally. |
| White markings erased during keying | Preserve markings and natural color | Compare remaining near-white matte candidates with the original source to help protect interior white detail. |
| Model output is still opaque | Strong output constraints | Record `opaque-output` for review rather than claiming success. |

### How to evaluate the next prompt change

Prompt iterations should be tested on a fixed "hard case" set, not only on easy fish with clean contrast. A useful set includes:

- branching coral against rock;
- translucent fins or tentacles against water;
- hair, spines, antennae, or many thin legs;
- a white or pale organism on a light background;
- an organism whose color matches the substrate;
- labels, watermark text, glass reflections, or strong shadows; and
- a subject touching or nearly touching an image edge.

Score each output on the same six checks:

| Check | Pass condition |
| --- | --- |
| Completeness | No visible anatomy or fine structure is missing. |
| Fidelity | Shape, texture, markings, translucency, and color still match the source. |
| Isolation | Water, rock, sand, glass, text, shadows, and scenery are gone. |
| Composition | Nothing is cropped and the margin is small but present. |
| Matte quality | The outside is transparent or uniformly removable white. |
| Artifact control | No halos, invented edges, smoothing, relighting, or reconstruction. |

When testing a revision, keep the model, image size, aspect-ratio selection, source set, and post-processing fixed. Change one prompt concept at a time and record both the visual score and the resulting transparency state (`native-transparent`, `post-processed-white-edge`, `white-matte`, or `opaque-output`). Otherwise a model or pipeline change can be mistaken for a prompt improvement.

### Known limitations

- The prompt assumes one primary visible organism. Images with multiple overlapping organisms need an explicit selection rule.
- No prompt can faithfully restore anatomy that is cropped, heavily occluded, or absent in the source; the "do not reconstruct" clause intentionally favors honesty over completeness.
- The fast model is appropriate for a broad first pass, while the detailed model remains useful for coral branches, hair, fins, and low-contrast edges.
- Image generation is variable. The prompt reduces the failure space but does not eliminate the need for QA and reprocessing.
- The transparent-PNG/white-background wording is operationally effective but not semantically clean. If the API output is changed to a format with dependable alpha, the prompt should be simplified to a single alpha contract. If both paths remain supported, the fallback can be stated explicitly: "Return transparency when supported; otherwise use a flat pure `#FFFFFF` background."

### Takeaway

The winning change was not adding more adjectives. It was turning an underspecified visual request into a testable contract:

1. identify the biological subject;
2. enumerate the details that must survive;
3. prohibit generative reinterpretation;
4. enumerate domain-specific background content;
5. constrain framing; and
6. give downstream code a predictable matte when alpha is unavailable.

That combination makes the result useful for the application, not just convincing at a glance.
