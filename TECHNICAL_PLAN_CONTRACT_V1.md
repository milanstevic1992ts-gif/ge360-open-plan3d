# GE360 Technical Plan Contract v1

Schema identifier:

`ge360-technical-plan-v1`

The transport payload remains `version: 4` and `kind: ge360-rough-survey`.  
`technicalSchema` identifies the technical-plan semantics added on top of that stable transport format.

## Compatibility rules

- Existing/legacy v4 payloads without `technicalSchema` are accepted and normalized to Technical Plan v1.
- Existing walls do not require or invent a construction thickness.
- `new` and `demolish` walls require a real construction thickness.
- Legacy doors without `doorKind` normalize to `internal`.
- Legacy windows without `windowKind` normalize to `single`.
- Technical fields are persisted through the authoritative CAD model and processed JSON.

## Wall contract

Required base fields:

- `id`
- `a {x,y}`
- `b {x,y}`
- `lengthCm` when measured

Technical fields:

- `constructionState`: `existing | demolish | new | close-opening | new-opening`
- `constructionThicknessCm`: positive number, required only for `demolish` and `new`
- `thicknessMm`: transport compatibility value derived from the explicit construction thickness when required

Invariant:

`existing`, `close-opening` and `new-opening` never receive a fabricated construction thickness from the frontend.

## Opening contract

Shared:

- `id`
- `type: door | window`
- `wallId`
- `widthCm`
- `heightCm`
- `offsetCm`
- `referenceEnd: a | b`
- `position` may be retained as sketch fallback

### Doors

- `doorKind: internal | double | sliding | armored | armored-double`
- `category: interior | armored`
- `leaves`
- `sliding`
- `armored`
- `hingeEnd: a | b` for swing doors
- `swingDirection: inward | outward`
- `swingSide: -1 | 1`
- `slideTo: a | b` for sliding doors

Canonical rules:

- `double` and `armored-double` have two leaves.
- `armored` and `armored-double` imply `armored=true` and `category=armored`.
- `sliding` uses `slideTo` and has no hinge/swing fields.
- Swing doors have no `slideTo`.

### Windows and balcony doors

- `windowKind: single | double | triple | sliding | balcony | balcony-double`
- `leaves`
- `sliding`
- `balconyDoor`
- `sillHeightCm`

Canonical rules:

- `triple` has three leaves.
- `double`, `sliding` and `balcony-double` have two leaves.
- `balcony` and `balcony-double` have `balconyDoor=true` and sill height 0.

## Rooms

Room identity remains based on:

- `id`
- `name`
- `wallIds`
- `type`
- optional `heightCm`
- optional `tilingHeightCm`

Authoritative room geometry remains calculated by the backend.

## Works

Works keep the current contract:

- `id`
- `catalogId`
- `label`
- `targetType: room | plan | wall`
- `targetId`
- `targetIds`
- `quantityRule`
- `manualQuantity`
- `unit`
- `note`

Quantities derived from authoritative geometry remain a backend responsibility.

## Construction summary

The frontend may send the deterministic `construction` summary generated from measured geometry. It is supporting context, not a replacement for authoritative backend geometry.

No waste factor, rubble expansion factor, or material coefficient may be invented by this contract.

## PDF / presentation semantics

Technical metadata must survive until exports so that PDF and clean-plan rendering can distinguish:

- existing / demolition / new construction / closure / new opening
- internal / double / sliding / armored doors
- single / double / triple / sliding windows
- balcony doors
- hinge and swing direction

Door/window placement offsets are retained as geometry data but are not required as permanent graphical dimensions on the clean plan.

## Change policy

Do not rename or repurpose fields in Technical Plan v1.

A breaking semantic change requires a new `technicalSchema` identifier. Transport `version` should change only if the outer API payload structure itself becomes incompatible.
