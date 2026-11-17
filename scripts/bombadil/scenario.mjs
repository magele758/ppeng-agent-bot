// Reused by the browser specification, the fixture seeder and the delivery check.
export const botNames = ['Bombadil Alpha', 'Bombadil Bravo'];
export const historyMarker = name => '[history/' + name + ']';
export const sendMarker = name => '[probe/' + name + ']';

export function transcriptIsIsolated(selected, text) {
  return botNames.every(name => name === selected ||
    (!text.includes(historyMarker(name)) && !text.includes(sendMarker(name))));
}

export function verifyDelivery(name, messages) {
  const texts = messages.filter(message => message.role === 'user')
    .flatMap(message => message.parts.filter(part => part.type === 'text').map(part => part.text));
  if (!texts.every(text => transcriptIsIsolated(name, text))) {
    throw new Error('Probe delivered to wrong bot: ' + name);
  }
  const delivered = texts.filter(text => text === sendMarker(name)).length;
  if (!delivered) throw new Error('Insufficient send coverage: ' + name);
  return { name, delivered };
}
