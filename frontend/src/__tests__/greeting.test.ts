import { describe, expect, it } from 'vitest';
import { timeOfDayGreeting } from '../lib/greeting';
import { formatFirstName, formatPhysicianLastName } from '../lib/format';

/**
 * P4 greeting helpers. timeOfDayGreeting boundaries are LOCAL-time: [0,12) morning,
 * [12,18) afternoon, [18,24) evening. The name parsers feed "Good <tod>, <FirstName>"
 * (staff HomePage) and "Good <tod>, Dr. <LastName>" (PhysicianQueuePage).
 */

describe('timeOfDayGreeting boundaries', () => {
  const at = (hour: number, minute = 0) => new Date(2026, 5, 11, hour, minute);

  it('midnight through 11:59 is morning', () => {
    expect(timeOfDayGreeting(at(0))).toBe('Good morning');
    expect(timeOfDayGreeting(at(11, 59))).toBe('Good morning');
  });

  it('12:00 through 17:59 is afternoon', () => {
    expect(timeOfDayGreeting(at(12))).toBe('Good afternoon');
    expect(timeOfDayGreeting(at(17, 59))).toBe('Good afternoon');
  });

  it('18:00 through 23:59 is evening', () => {
    expect(timeOfDayGreeting(at(18))).toBe('Good evening');
    expect(timeOfDayGreeting(at(23, 59))).toBe('Good evening');
  });
});

describe('formatFirstName (staff hero greeting)', () => {
  it('takes the first token of the stored display name', () => {
    expect(formatFirstName('Riley Staffer, RN')).toBe('Riley');
    expect(formatFirstName('Ada Min')).toBe('Ada');
  });

  it('trims and degrades to empty (caller falls back to the plain greeting)', () => {
    expect(formatFirstName('  Jo  ')).toBe('Jo');
    expect(formatFirstName('')).toBe('');
    expect(formatFirstName(null)).toBe('');
    expect(formatFirstName(undefined)).toBe('');
  });
});

describe('formatPhysicianLastName (Dr. <LastName> greeting)', () => {
  it('strips the comma credential suffix and takes the last name token', () => {
    expect(formatPhysicianLastName('Jane Smith, DO')).toBe('Smith');
    expect(formatPhysicianLastName('Ryan J. Kasky, DO')).toBe('Kasky');
    expect(formatPhysicianLastName('Dr. Jane Smith-Jones, MD, FACS')).toBe('Smith-Jones');
  });

  it('strips comma-less trailing uppercase credentials ("Jane Smith DO")', () => {
    expect(formatPhysicianLastName('Jane Smith DO')).toBe('Smith');
    expect(formatPhysicianLastName('Jane Smith MD PhD')).toBe('Smith');
  });

  it('never eats a mixed-case surname that resembles a credential', () => {
    expect(formatPhysicianLastName('Hien Do')).toBe('Do');
  });

  it('single token returned as-is; empty/null degrade to empty string', () => {
    expect(formatPhysicianLastName('Smith')).toBe('Smith');
    expect(formatPhysicianLastName('')).toBe('');
    expect(formatPhysicianLastName(null)).toBe('');
    expect(formatPhysicianLastName(undefined)).toBe('');
  });
});
