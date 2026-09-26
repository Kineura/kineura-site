// Composes the notification email. Pure — no SES import, no I/O.

const SUBJECTS = {
  'early-access': 'Kineura early access request',
  'coach-team': 'Kineura team/coach inquiry',
  'research-clinical': 'Kineura research/clinical inquiry',
};

export function subjectFor(formType) {
  return SUBJECTS[formType] ?? 'Kineura inquiry';
}

export function buildEmail(fields, { submittedAt, priorCount = 0 } = {}) {
  const lines = [
    `Form: ${fields.formType}`,
    `Name: ${fields.name}`,
    `Email: ${fields.email}`,
  ];

  if (fields.organization) lines.push(`Organization: ${fields.organization}`);
  if (fields.message) lines.push('', 'Message:', fields.message);

  lines.push('', `Submitted: ${submittedAt}`);
  if (priorCount > 0) {
    lines.push(`Note: this address has submitted ${priorCount} time(s) before.`);
  }

  return {
    subject: subjectFor(fields.formType),
    body: lines.join('\n'),
    replyTo: fields.email,
  };
}
