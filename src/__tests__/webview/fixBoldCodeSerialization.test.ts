import { fixBoldCodeSerialization } from '../../webview/utils/markdownSerialization';

describe('fixBoldCodeSerialization', () => {
  describe('pattern 1: bold closes before adjacent code', () => {
    it('merges bold through trailing code span', () => {
      const bug = '**If **`REVIEW_HAS_ISSUES`:';
      expect(fixBoldCodeSerialization(bug)).toBe('**If `REVIEW_HAS_ISSUES`**:');
    });

    it('merges when bold text has multiple words', () => {
      const bug = '**the variable **`x`:';
      expect(fixBoldCodeSerialization(bug)).toBe('**the variable `x`**:');
    });

    it('leaves legit bold + separated code untouched', () => {
      const ok = '**bold** and `code`';
      expect(fixBoldCodeSerialization(ok)).toBe(ok);
    });

    it('leaves bold without trailing space untouched (not a serializer artifact)', () => {
      const ok = '**bold**`code`';
      expect(fixBoldCodeSerialization(ok)).toBe(ok);
    });
  });

  describe('pattern 2: bold wrapping code gets flipped into code with literal **', () => {
    it('unwraps code with **X** back to bold-wrapping-code', () => {
      expect(fixBoldCodeSerialization('`**dots/**`')).toBe('**`dots/`**');
    });

    it('handles the pattern mid-sentence', () => {
      const bug = 'the `**config/**` folder';
      expect(fixBoldCodeSerialization(bug)).toBe('the **`config/`** folder');
    });

    it('leaves plain code untouched', () => {
      const ok = 'just `code`';
      expect(fixBoldCodeSerialization(ok)).toBe(ok);
    });

    it('leaves code with single asterisk untouched', () => {
      const ok = '`*one*`';
      expect(fixBoldCodeSerialization(ok)).toBe(ok);
    });
  });

  describe('pattern 3: link wrapping code gets flipped into code containing link syntax', () => {
    it('unwraps code with [text](url) back to link-wrapping-code', () => {
      const bug = '`[config/vscode/README.md](config/vscode/README.md)`';
      expect(fixBoldCodeSerialization(bug)).toBe(
        '[`config/vscode/README.md`](config/vscode/README.md)'
      );
    });

    it('handles arbitrary URLs', () => {
      const bug = '`[label](https://example.com)`';
      expect(fixBoldCodeSerialization(bug)).toBe('[`label`](https://example.com)');
    });

    it('handles the pattern mid-sentence', () => {
      const bug = 'see `[docs.md](./docs.md)` for details';
      expect(fixBoldCodeSerialization(bug)).toBe('see [`docs.md`](./docs.md) for details');
    });

    it('leaves legit code spans alone', () => {
      const ok = '`config/vscode/README.md`';
      expect(fixBoldCodeSerialization(ok)).toBe(ok);
    });

    it('leaves legit markdown links alone', () => {
      const ok = '[text](url)';
      expect(fixBoldCodeSerialization(ok)).toBe(ok);
    });
  });

  describe('combined document', () => {
    it('fixes all three patterns in one pass', () => {
      const input = [
        '**If **`X`:',
        'the `**dots/**` folder',
        'see `[docs.md](./docs.md)`',
      ].join('\n');
      const expected = [
        '**If `X`**:',
        'the **`dots/`** folder',
        'see [`docs.md`](./docs.md)',
      ].join('\n');
      expect(fixBoldCodeSerialization(input)).toBe(expected);
    });

    it('is a no-op on already-correct markdown', () => {
      const ok = [
        '**If `X`**:',
        'the **`dots/`** folder',
        'see [`docs.md`](./docs.md)',
        'plain **bold** and plain `code` and plain [link](url)',
      ].join('\n');
      expect(fixBoldCodeSerialization(ok)).toBe(ok);
    });
  });
});
