# Studio Dashboard

The workspace keeps current work, durable notes, and small decisions close together.

## Today

- [x] Capture the visual regression surface
- [ ] Review the native workspace controls
- [ ] Link the [[Project Atlas]] implementation notes

> A calm workspace leaves the document in charge of the screen.

## Reference Table

| Surface | Owner | Status |
| --- | --- | --- |
| Tabs | Reader | Ready |
| Find | Editor | Review |
| Panels | Workspace | Ready |

## Implementation Notes

Use `NSViewController` and native controls for the workspace shell.
The workspace remains readable when the sidebar yields to a narrow window.

```swift
let workspace = "native"
```