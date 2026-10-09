'use strict';

const provider = {
  provider_id: 'local',
  shop_type: 'local',
  supports(platformName) {
    return /^TikTok Shop后台\s+本土-/u.test(String(platformName));
  },
};

module.exports = provider;
