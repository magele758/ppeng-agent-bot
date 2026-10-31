import assert from 'node:assert/strict';
import test from 'node:test';
import {
  secureFormCardFace,
  secureFormResultCard,
  secureFormSubmitBody,
  secureFormSubmitBodyMulti,
  type SecureFormCardMultiFace
} from './secure-form-card.ts';

const OTP = 'chat-card-OTP-440191';

test('chat card is one masked field and the submit body is not chat text [AC:secure-form#AC-5]', () => {
  const pending = secureFormCardFace({
    toolName: 'secure_form',
    args: { field: 'otp', label: 'Bank', prompt: 'Enter the code' }
  });
  assert.ok(pending);
  assert.equal(pending.field, 'otp');
  assert.equal(pending.masked, true);
  assert.equal(secureFormCardFace({ toolName: 'vault_fill', args: { field: 'otp' } }), null);
  assert.equal(secureFormCardFace({ toolName: 'ask_user', args: { question: 'code?' } }), null);

  const content = JSON.stringify({
    card: {
      kind: 'secure_form',
      id: 'sform_1',
      field: 'otp',
      label: 'Bank',
      prompt: 'Enter the code',
      masked: true,
      status: 'pending'
    },
    receipt: { kind: 'secure_form_receipt', id: 'sform_1', field: 'otp', status: 'pending', text: 'waiting' }
  });
  const face = secureFormResultCard(content);
  assert.ok(face);
  assert.equal(face.id, 'sform_1');
  assert.equal(JSON.stringify(face).includes(OTP), false);

  const body = secureFormSubmitBody(face, OTP);
  assert.deepEqual(body, { action: 'submit', id: 'sform_1', value: OTP });
  const chatText = `${content} ${face.prompt} ${face.label}`;
  assert.equal(chatText.includes(OTP), false);
  assert.equal(secureFormResultCard('not json'), null);
  assert.equal(secureFormResultCard(JSON.stringify({ receipt: { status: 'filled' } })), null);
});
test('multi-field card renders and submits multiple values [AC:secure-form-multi#AC-1] [AC:secure-form-multi#AC-2]', () => {
  const content = JSON.stringify({
    card: {
      kind: 'secure_form',
      id: 'sform_2',
      fields: [
        { field: 'username', label: 'Username' },
        { field: 'password', label: 'Password' }
      ],
      masked: true,
      status: 'pending'
    },
    receipt: { kind: 'secure_form_receipt', id: 'sform_2', status: 'pending', text: 'waiting' }
  });
  const face = secureFormResultCard(content);
  assert.ok(face);
  assert.equal(face.id, 'sform_2');
  assert.ok('fields' in face);
  const multiFace = face as SecureFormCardMultiFace;
  assert.equal(multiFace.fields.length, 2);
  assert.equal(multiFace.fields[0].field, 'username');
  assert.equal(multiFace.fields[1].field, 'password');

  const body = secureFormSubmitBodyMulti(multiFace, {
    username: 'testuser',
    password: 'testpass'
  });
  assert.deepEqual(body, {
    action: 'submit',
    id: 'sform_2',
    values: { username: 'testuser', password: 'testpass' }
  });
});

test('single-field backward compat still works [AC:secure-form-multi#AC-3]', () => {
  const content = JSON.stringify({
    card: {
      kind: 'secure_form',
      id: 'sform_3',
      field: 'password',
      label: 'Password',
      prompt: 'Enter password',
      masked: true,
      status: 'pending'
    }
  });
  const face = secureFormResultCard(content);
  assert.ok(face);
  assert.equal(face.id, 'sform_3');
  assert.ok(!('fields' in face));
  assert.equal(face.field, 'password');
});

test('username field is recognized [AC:secure-form-multi#AC-9]', () => {
  const pending = secureFormCardFace({
    toolName: 'secure_form',
    args: { field: 'username', label: 'Username', prompt: 'Enter username' }
  });
  assert.ok(pending);
  assert.equal(pending.field, 'username');
});
