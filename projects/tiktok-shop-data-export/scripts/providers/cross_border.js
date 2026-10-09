'use strict';

const provider = {
  provider_id: 'cross_border',
  shop_type: 'cross_border',
  supports(platformName) {
    return /^TikTok Shop后台\s+跨境(?:\(新\))?-/u.test(String(platformName));
  },
};

module.exports = provider;
