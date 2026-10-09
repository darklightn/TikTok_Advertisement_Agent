'use strict';

function fulfillmentBodies() {
  const metric = (metricType, currentValue, numerator, denominator, currentLabel = 1) => ({
    metric_type: metricType,
    current_value: currentValue,
    current_numerator: numerator,
    current_denominator: denominator,
    current_label: currentLabel,
    metric_date_info: {
      metric_assessment_period_start: '2026-07-20',
      metric_assessment_period_end: '2026-07-26',
      metric_date: '2026-07-26',
      metric_assessment_by: 'official_window',
    },
  });
  return {
    timeliness: {
      metric_date_info: { metric_date: '2026-07-27' },
      timeliness_period: 1,
      timeliness_data_sum: { metric_type: 'Stocking2Delivery', value: 65.54, timeliness_diff: 8.03, last_cycle_value: 57.51, industry_average: 80.84, industry_name: 'Home & Care' },
      timeliness_data_list: [
        { metric_type: 'Stocking2RTS', value: 8.58, timeliness_diff: -2.08, last_cycle_value: 10.66, industry_average: 9.47, industry_name: 'Home & Care' },
        { metric_type: 'RTS2TTS', value: 7.04, timeliness_diff: 0.31, last_cycle_value: 6.73, industry_average: 11.86, industry_name: 'Home & Care' },
        { metric_type: 'TTS2Delivery', value: 49.92, timeliness_diff: 9.79, last_cycle_value: 40.13, industry_average: 59.52, industry_name: 'Home & Care' },
      ],
    },
    metrics: {
      metrics_data_list: [
        metric('LDR', 0, 0, 619),
        metric('SFCR', 0, 0, 520),
        metric('FDR', 97.6, 13306, 13633),
      ],
    },
    suggestions: {
      dispatch_suggestion: {
        ship_within_twenty_four_hours: 1,
        auto_cancel_within_twenty_four_hours: 2,
        shipping_overdue: 3,
      },
    },
  };
}

module.exports = { fulfillmentBodies };
