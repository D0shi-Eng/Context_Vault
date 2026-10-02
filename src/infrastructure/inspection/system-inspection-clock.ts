import type { InspectionClock } from '../../application/ports/inspection-services.js';

export class SystemInspectionClock implements InspectionClock {
  now(): Date {
    return new Date();
  }
}
