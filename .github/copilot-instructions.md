# Copilot Instructions for Processes-Automation

## Repository State
- This repository currently contains no source files, only `.git` metadata.
- Do not infer a framework, language, or architecture from the repository name alone.
- If you are asked to implement functionality, first confirm the intended stack and desired project structure.

## Agent Behavior
- Report that the repository is empty and request more details before adding code.
- Avoid creating arbitrary files or scaffolding without explicit user direction.
- If a user asks to initialize the project, focus on the target platform and workflow they request.

## How to Proceed When Code Appears
- Inspect the root directories and any new files before making changes.
- Look for common build files like `package.json`, `pyproject.toml`, `Dockerfile`, `README.md`, or `Makefile`.
- Prefer minimal, direct edits that align with existing conventions once code exists.

## Notes for Future Updates
- Once source files are present, update this guidance with:
  - actual architecture and major components
  - build/test/debug commands
  - project-specific patterns and conventions
  - integration points and external dependency details
