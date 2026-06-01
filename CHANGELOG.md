# pixeltileengine changelog

## 1.2.3 - 2026-06-01

### Improved

- Improved dynamic lighting performance by switching to squared-distance checks before square-root work
- Improved lighting performance by caching each light's squared radius when instructions are built
- Improved per-pixel color writes by skipping full lighting lookups when there are no active lights and no weighted tint

## 1.2.2 - 2026-06-01

### Improved

- Improved render performance by resizing the backing canvas only when dimensions actually change
- Improved rotated sprite performance by caching trigonometric values outside inner pixel loops
- Improved reflection performance by caching sun direction values per draw call

### Fixed

- Fixed diagnostics in `getCanvasCoordinatePrecise` caused by unused initial assignments

## 1.2.1 - 2026-06-01

### Fixed

- Fixed `partProgEmber` so `maxChance: 0` works correctly instead of falling back to default chance
- Fixed `partProgSplat` so `stayOnGround` can be explicitly set to `false`
- Fixed mirrored sprite sampling off-by-one in `drawImageData`
- Fixed sepia filter channel calculations to use original channel values
- Fixed `drawSprite` so `opacity: 0` and `scale: 0` are honored
- Fixed `drawSprite` color filter handling to guard against non-string input

## 1.2.0 - 2026-01-14

### Water shimmer and refraction effetcs

### Fixed

- Many of the particle effects were fixed or improved
- Fixes to scaling and rotation

## 1.1.0 - 2025-04-19

### Added

- Initial build of particle effects engine
- Several jsDoc tags

## 1.0.0 - 2025-03-06

### Changed

- Converted from managed script to git repo