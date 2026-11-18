# Additional read-only vehicle data sources

Research date: 2026-11-18. These are source-code findings, not successful reads from the user's G07. No connection to the car was made during this research.

## What the diagnostic applications establish

The MIT idrive7-apps project uses the head unit's TASU diagnostic gateway to read ECU data. Fault-code access establishes a possible transport path; it does not establish the meaning, availability, or update rate of every measurement on every ECU variant.

Primary references:
- [Diagnostic transport](https://github.com/cauliflowermossgrape/idrive7-apps/blob/main/kit/runtime/diag.js)
- [M Vitals configuration](https://github.com/cauliflowermossgrape/idrive7-apps/blob/main/apps/car_vitals/app.json)
- [ZF 8HP reader and variant limitations](https://github.com/cauliflowermossgrape/idrive7-apps/blob/main/apps/zf8hp/README.md)

## Candidate map for a separately reviewed integration

| Measurement | ECU / diagnostic identifier | Evidence | Remaining qualification |
|---|---|---|---|
| Front-axle torque | LMV 0x19 / DB32 | M Vitals; LMV_G11 catalog: signed integer divided by 4, Nm; actual, target and qualifier fields | Confirm G07 ECU variant and qualifier meaning. This is not a directly measured front/rear percentage split. |
| Transmission oil temperature | EGS 0x18 / 6000 | ZF 8HP / M Vitals, supported GSZFBCE variant, raw byte minus 40 | Read ECU identification first and match a supported variant. Other EGS families differ. |
| Four corner heights | VDP 0x76 / DC05 | VDP_G11 catalog: four Motorola floating-point fields, multiplied by 1000 to mm | Catalog is unverified on a car. Confirm variant, exact payload schema and reference level before displaying height relative to normal. |
| Suspension level | VDP 0x76 / D8EC | VDP_G11 catalog: low / standard / high states | These three states do not establish all six levels currently drawn in the app. |
| Four wheel speeds | DSC 0x29 / DBE4 | DSC_G30N catalog: four signed integers divided by 100, km/h | Confirm DSC variant, layout, invalid values and measured response. This is a separate source from the unresolved SOME/IP wheel-RPM raw values. |
| Brake pressures | DSC 0x29 / DBE5 | DSC_G30N catalog: signed integers divided by 10, bar | Several nominal wheel fields are axle circuits or unused depending on variant. Do not present these as four independent brake interventions. |
| Steering cross-check | EPS 0x30 / DB57 | EPS_G11 catalog: pinion angle, angular speed and sensor state | Pinion angle is not automatically the same physical quantity/reference as steering-wheel angle. Not a drop-in fix for current steering jumps. |

## Catalog provenance and limits

The [m550-analyzer project](https://github.com/strulock/m550-analyzer) is MIT licensed and targets a G30 M550i. Its README explicitly says the module catalogs have not been checked against the car and warns that a wrong variant can decode plausible nonsense. Availability of entries is therefore discovery evidence only.

- [VDP suspension catalog](https://github.com/strulock/m550-analyzer/blob/main/docs/channels/VDP_G11.md)
- [DSC catalog](https://github.com/strulock/m550-analyzer/blob/main/docs/channels/DSC_G30N.md)
- [EPS catalog](https://github.com/strulock/m550-analyzer/blob/main/docs/channels/EPS_G11.md)
- [LMV catalog](https://github.com/strulock/m550-analyzer/blob/main/docs/channels/LMV_G11.md)
- [License](https://github.com/strulock/m550-analyzer/blob/main/LICENSE)

This note does not import code or enable polling. Before implementation, pin the source revision, retain applicable attribution, verify actual schema definitions rather than treating field ordinals as byte offsets, and require a supported ECU identity plus response-length/identifier validation. Read only the selected documented measurements, with serialized bounded requests and explicit freshness. Do not adopt full-catalog probing, fault clearing, actuator commands, coding, or session/security changes from other tools.

## Still unresolved

Direct rear-axle torque, verified torque split, rear differential locking degree, four independent brake interventions, body roll/pitch conversion and camera video access are not established by these findings. Diagnostic measurement access does not itself provide video frames. Existing observed engine, tyre and dynamics signals remain the production baseline.
