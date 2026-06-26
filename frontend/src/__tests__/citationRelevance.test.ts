import { describe, expect, it } from 'vitest';
import {
  citationMayBeOffTopic,
  citationRelevanceScore,
  relevanceTokens,
} from '../lib/citationRelevance';

describe('citationRelevance heuristic', () => {
  describe('relevanceTokens', () => {
    it('lowercases, drops stopwords + short tokens, and folds simple plurals', () => {
      const t = relevanceTokens('Obstructive sleep apneas and the migraines of veterans');
      expect(t.has('obstructive')).toBe(true);
      expect(t.has('sleep')).toBe(true);
      expect(t.has('apnea')).toBe(true); // plural folded
      expect(t.has('migraine')).toBe(true); // plural folded
      expect(t.has('and')).toBe(false); // stopword
      expect(t.has('the')).toBe(false); // stopword
      expect(t.has('of')).toBe(false); // short + stopword
      expect(t.has('veteran')).toBe(false); // corpus-filler stopword
    });
  });

  describe('citationMayBeOffTopic — relevant cases do NOT warn', () => {
    it('on-topic citation vs matching passage: no warning', () => {
      const citation =
        'Intermittent hypoxia in obstructive sleep apnea drives sympathetic activation and hypertension';
      const passage =
        'The veteran’s obstructive sleep apnea, through intermittent hypoxia and sympathetic activation, more likely than not aggravates his hypertension.';
      expect(citationMayBeOffTopic(citation, passage)).toBe(false);
      expect(citationRelevanceScore(citation, passage)).toBeGreaterThanOrEqual(0.17);
    });

    it('on-topic citation vs the claimed condition alone: no warning', () => {
      const citation = 'Tinnitus prevalence and noise-induced hearing loss in military cohorts';
      const condition = 'tinnitus';
      expect(citationMayBeOffTopic(citation, condition)).toBe(false);
    });
  });

  describe('citationMayBeOffTopic — off-topic cases DO warn', () => {
    it('unrelated citation vs passage: warns', () => {
      const citation = 'Dietary fiber intake and colorectal cancer screening adherence in adults';
      const passage =
        'The veteran’s obstructive sleep apnea, through intermittent hypoxia, more likely than not aggravates his hypertension.';
      expect(citationMayBeOffTopic(citation, passage)).toBe(true);
    });

    it('unrelated citation vs the claimed condition: warns', () => {
      const citation = 'Knee osteoarthritis progression after anterior cruciate ligament repair';
      const condition = 'post-traumatic stress disorder';
      expect(citationMayBeOffTopic(citation, condition)).toBe(true);
    });
  });

  describe('citationMayBeOffTopic — NEVER warns when there is nothing to judge', () => {
    it('empty target → no warning (we have nothing to compare against)', () => {
      expect(citationMayBeOffTopic('anything at all here', '')).toBe(false);
      expect(citationMayBeOffTopic('anything at all here', '   ')).toBe(false);
    });
    it('empty citation subject → no warning', () => {
      expect(citationMayBeOffTopic('', 'obstructive sleep apnea')).toBe(false);
    });
  });
});
