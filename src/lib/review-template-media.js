'use strict';

function matchesReviewTemplateMedia({ hasImageHeader = false, hasPhoto = false } = {}) {
  return (hasImageHeader === true) === (hasPhoto === true);
}

module.exports = {
  matchesReviewTemplateMedia,
};
