# How an AI Agent Coding Workflow Works

An AI coding agent does more than generate a block of code. It can work through a software task from the initial request to a tested change.

The basic workflow is:

```text
Describe the outcome
  -> inspect the repository
  -> understand the existing experience
  -> plan the change
  -> implement it
  -> test the behavior
  -> review and publish
```

## 1. Describe the outcome

Start with the result you want and why it matters.

For example:

> Add an Image description button to animal results in the Display view so customers can choose to read more about each animal.

The request does not need to prescribe every file or function. The agent can discover those details from the repository.

## 2. Inspect the repository

Before editing, the agent reviews the project structure, documentation, current experience, tests, and repository-specific instructions.

This step answers questions such as:

- Where does the current behavior live?
- How does the user reach and interact with it?
- Which existing patterns and data should be reused?
- What could break if the change is made incorrectly?

For the Image description button, the agent traces how Display view results are rendered, what descriptive content is available, and how images already support accessibility.

## 3. Plan the change

The agent turns the requested outcome into a focused implementation plan. It identifies the interface, behavior, accessibility requirements, tests, and documentation that need to change.

The plan keeps the work focused and gives the human a chance to correct the direction before too much code changes.

## 4. Implement within the existing design

The agent edits the repository instead of producing disconnected sample code. New behavior should fit the existing interface, naming, data flow, and error handling.

In this project, the Image description button is added to animal results in the Display view. Selecting it reveals the existing metadata-backed description as optional customer-facing content. Results without a description do not show an empty button, and the images keep their HTML `alt` attributes for assistive technology.

## 5. Verify the result

The agent checks its own work by running the project's tests, checking syntax, and exercising important user flows in a browser when the task affects the interface.

For this feature, verification confirms that the Image description button appears in the right place, reveals the correct text, works with a keyboard, and does not disrupt the result layout or the image's existing accessibility behavior.

Verification is part of the implementation, not a separate cleanup step.

## 6. Review what changed

Before publishing, the agent reviews the final diff and confirms that only intended files are included. Unrelated local work is left untouched.

The human remains responsible for product judgment: whether the feature solves the right problem, communicates clearly, and is appropriate to ship.

## 7. Publish through the normal workflow

When authorized, the agent can create a branch, commit the scoped changes, push them, open a pull request, wait for automated checks, and merge after those checks pass.

The result is a normal, reviewable software change rather than code copied out of a chat window.

## What the human and agent each contribute

The human contributes:

- the goal and product context;
- product, design, and accessibility judgment;
- corrections when the direction is wrong; and
- approval for consequential actions.

The agent contributes:

- repository and product discovery;
- implementation across relevant files;
- consistency with the existing experience;
- testing and verification; and
- a clear record of what changed.

The strongest workflow is collaborative. The human defines what matters, while the agent handles the detailed path from request to verified change.

## Example from this repository

The Display view Image description button followed this workflow:

1. The goal was defined: let customers reveal more information about an animal from its Display view result.
2. The agent traced the result-card interface, metadata, accessibility behavior, styling, and tests.
3. It planned a small, on-demand control that reused the available image-description content.
4. It added the Image description button only to results with available descriptions.
5. It treated the visible description and the image's HTML `alt` attribute as related but separate parts of the experience.
6. It tested the interaction, keyboard behavior, and result layout.
7. It reviewed the scoped change and prepared it for the normal pull-request workflow.
