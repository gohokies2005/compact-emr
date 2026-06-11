// SES-sandbox forwarding mode lock (Ryan 2026-06-10): with EMAIL_REDIRECT_ALL_TO set, every send
// goes to the trap inbox with the [FWD to <real>] subject + staff banner; unset = byte-identical
// legacy behavior. This guard is what keeps a veteran from ever being emailed directly while SES
// production access is pending — treat a failure here as a privacy incident, not a flake.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { sendSpy } = vi.hoisted(() => ({ sendSpy: vi.fn(async () => ({ MessageId: 'm-1' })) }));
vi.mock('@aws-sdk/client-ses', () => ({
  SESClient: class { send = sendSpy; },
  SendEmailCommand: class { constructor(public readonly input: unknown) {} },
}));
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class { send = vi.fn(); },
  GetSecretValueCommand: class {},
}));

import { sendEmail } from '../services/mailer.js';

function lastCommandInput(): { Destination: { ToAddresses: string[]; BccAddresses?: string[] }; Message: { Subject: { Data: string }; Body: { Text: { Data: string } } } } {
  const call = sendSpy.mock.calls.at(-1) as unknown[];
  return (call[0] as { input: never }).input;
}

beforeEach(() => {
  sendSpy.mockClear();
  process.env.SES_FROM_ADDRESS = 'info@flatratenexus.com';
});
afterEach(() => {
  delete process.env.EMAIL_REDIRECT_ALL_TO;
});

describe('sendEmail — SES-sandbox forwarding mode', () => {
  it('redirect set: delivers to the trap inbox with [FWD] subject, banner, no BCC', async () => {
    process.env.EMAIL_REDIRECT_ALL_TO = 'info@flatratenexus.com';
    const r = await sendEmail({ to: 'veteran@example.com', subject: 'Your nexus letter is ready', textBody: 'Link: X\nPassword: Y', bcc: 'admin@flatratenexus.com' });
    const cmd = lastCommandInput();
    expect(cmd.Destination.ToAddresses).toEqual(['info@flatratenexus.com']);
    expect(cmd.Destination.BccAddresses).toBeUndefined();
    expect(cmd.Message.Subject.Data).toBe('[FWD to veteran@example.com] Your nexus letter is ready');
    expect(cmd.Message.Body.Text.Data).toContain('Forward this email to: veteran@example.com');
    expect(cmd.Message.Body.Text.Data).toContain('Link: X\nPassword: Y'); // original body intact below the banner
    expect(r).toMatchObject({ sent: true, redirectedFrom: 'veteran@example.com' });
  });

  it('redirect unset: byte-identical legacy behavior (real recipient, BCC honored, no banner)', async () => {
    const r = await sendEmail({ to: 'veteran@example.com', subject: 'S', textBody: 'B', bcc: 'admin@flatratenexus.com' });
    const cmd = lastCommandInput();
    expect(cmd.Destination.ToAddresses).toEqual(['veteran@example.com']);
    expect(cmd.Destination.BccAddresses).toEqual(['admin@flatratenexus.com']);
    expect(cmd.Message.Subject.Data).toBe('S');
    expect(cmd.Message.Body.Text.Data).toBe('B');
    expect(r).toMatchObject({ sent: true });
    expect('redirectedFrom' in r).toBe(false);
  });

  it('redirect equal to the recipient: no double-banner, sends normally', async () => {
    process.env.EMAIL_REDIRECT_ALL_TO = 'info@flatratenexus.com';
    await sendEmail({ to: 'Info@FlatRateNexus.com', subject: 'S', textBody: 'B' });
    const cmd = lastCommandInput();
    expect(cmd.Message.Subject.Data).toBe('S');
    expect(cmd.Message.Body.Text.Data).toBe('B');
  });

  it('blank/whitespace redirect value is OFF', async () => {
    process.env.EMAIL_REDIRECT_ALL_TO = '   ';
    await sendEmail({ to: 'veteran@example.com', subject: 'S', textBody: 'B' });
    expect(lastCommandInput().Destination.ToAddresses).toEqual(['veteran@example.com']);
  });
});
