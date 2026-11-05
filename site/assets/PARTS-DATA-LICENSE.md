# Licence of `parts-data.js`

`site/assets/parts-data.js` is a **modified excerpt of the KiCad official symbol libraries** and is therefore distributed under the
**Creative Commons Attribution-ShareAlike 4.0 International licence (CC BY-SA 4.0)**:
<https://creativecommons.org/licenses/by-sa/4.0/legalcode>

The rest of this repository (code, site pages, device models) is licensed separately, as stated in the root `LICENSE` (Apache-2.0).
Only this data file, and any file you generate from it with `site/tools/make-parts-data.mjs`, carries CC BY-SA 4.0.

## Attribution

- **Original work:** KiCad official symbol libraries, <https://gitlab.com/kicad/libraries/kicad-symbols>, © the KiCad community, CC BY-SA 4.0.
  The exact commit used is recorded in the file header's `meta.source.commit` and shown in the Parts page footer.
- **Licence notice of the original:** <https://gitlab.com/kicad/libraries/kicad-symbols/-/blob/master/LICENSE.md>
  (CC BY-SA 4.0 with the KiCad exception for designs that use the libraries; that exception does **not** apply to redistributing the library data itself, which is what this file does).

## Changes we made (as CC BY-SA 4.0 requires us to say)

- Kept only some libraries: microcontrollers, sensors, converters, interface, memory, timing, drivers, displays, wireless, power management,
  analog front-end and security. Connectors, passives, discretes, regulators, FPGAs, logic and symbols for power are left out.
- Reduced each symbol to a record: name, description (cut to 160 characters), keywords (60), library, footprint name, datasheet link, pin count,
  pin names (up to 24, only for parts with at most 40 pins) and a few derived fields. Drawings and geometry are not included.
- Variant symbols that inherit from a parent symbol take the parent's pins.
- **Derived by us, not in the original:** the manufacturer (from the datasheet link's domain, for a fixed list of known manufacturer domains)
  and the interfaces (from pin names and from the words I2C, SPI, UART, CAN, USB in the description).
- `meta.vendorProfiles` is our own list of public company-level contact, support and documentation links (`site/tools/vendors.json`).

## Warranty

As in the original: provided without warranty of any kind. Check the manufacturer's current datasheet before you design or order anything.
Part and company names belong to their owners; Aletheon is not affiliated with or endorsed by them.
