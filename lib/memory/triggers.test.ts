import { describe, expect, it } from 'vitest';

import { phraseCoverage, triggerNgrams } from './triggers';

describe('triggerNgrams', () => {
  it('builds word bigrams for latin text', () => {
    const ngrams = triggerNgrams('gateway setup failure');
    expect(ngrams.has('gateway setup')).toBe(true);
    expect(ngrams.has('setup failure')).toBe(true);
    // Unigrams are included so single-word phrases can match by presence.
    expect(ngrams.has('gateway')).toBe(true);
    expect(ngrams.has('setup')).toBe(true);
    expect(ngrams.has('failure')).toBe(true);
    expect(ngrams.size).toBe(5);
  });

  it('keeps a single latin word as a unigram', () => {
    const ngrams = triggerNgrams('kubernetes');
    expect(ngrams.has('kubernetes')).toBe(true);
  });

  it('builds character bigrams for CJK text', () => {
    const ngrams = triggerNgrams('部署失败');
    expect(ngrams.has('部署')).toBe(true);
    expect(ngrams.has('署失')).toBe(true);
    expect(ngrams.has('失败')).toBe(true);
  });

  it('handles mixed CJK + latin text', () => {
    const ngrams = triggerNgrams('deploy 部署');
    expect(ngrams.has('部署')).toBe(true);
    expect(ngrams.has('deploy')).toBe(true);
  });

  it('returns an empty set for punctuation-only text', () => {
    expect(triggerNgrams('!!!').size).toBe(0);
  });
});

describe('phraseCoverage', () => {
  it('scores 1.0 when the message fully covers the phrase', () => {
    const message = triggerNgrams('the gateway setup is broken again');
    expect(phraseCoverage('gateway setup', message)).toBe(1);
  });

  it('scores partial coverage for partial matches', () => {
    const message = triggerNgrams('the gateway is broken');
    // "gateway setup" → bigram {gateway setup}; message has none of it.
    expect(phraseCoverage('gateway setup', message)).toBe(0);
  });

  it('matches single-word phrases by presence', () => {
    const message = triggerNgrams('kubernetes pods keep crashing');
    expect(phraseCoverage('kubernetes', message)).toBe(1);
  });

  it('matches CJK phrases by character-bigram coverage', () => {
    const message = triggerNgrams('这次部署失败的原因是什么');
    expect(phraseCoverage('部署失败', message)).toBe(1);
  });

  it('does not match unrelated text', () => {
    const message = triggerNgrams('write a sorting function');
    expect(phraseCoverage('gateway setup', message)).toBe(0);
    expect(phraseCoverage('部署失败', message)).toBe(0);
  });

  it('returns 0 for empty phrases', () => {
    const message = triggerNgrams('anything at all');
    expect(phraseCoverage('!!!', message)).toBe(0);
  });
});
