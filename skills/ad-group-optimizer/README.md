\# TikTok Ad Group Optimizer



\*\*Intelligent performance optimization agent that automatically analyzes ad group performance and recommends or implements bid, budget, and targeting optimizations based on data-driven thresholds.\*\*



\---



\## Quick Start



\### Installation

1\. Add this Skill to your StationOne workspace or related ai tool from Antropic, OpenAI or Google

2\. Ensure the \*\*TikTok for Business Connector\*\* is enabled and authenticated

3\. Activate the "TikTok Ad Group Optimizer" skill



\### Basic Usage

```

"Analyze all ad groups in campaign ID 12345678 for the last 7 days. 

My target is CPA under $15. Show me which ad groups should be scaled, 

which should be paused, and give me budget recommendations."

```



The Skill will:

\- Pull performance data from the specified campaign

\- Categorize ad groups by performance tier

\- Provide actionable optimization recommendations

\- Optionally implement approved changes automatically



\---



\## Target Platform



\*\*Compatible with:\*\*

\- ✅ StationOne (primary platform)

\- ✅ Claude (Anthropic)

\- ✅ ChatGPT (OpenAI)

\- ✅ Gemini (Google)



\*\*Platform-specific notes:\*\*

\- Best performance on StationOne with full TikTok Connector integration

\- Limited functionality on platforms without MCP support (manual data input required)



\---



\## Prerequisites / Dependencies



\### Required

\- \*\*TikTok for Business MCP Connector\*\* (authenticated)

\- Valid TikTok Ads account with Advertiser ID

\- API access with the following permissions:

&#x20; - `campaign.read`

&#x20; - `adgroup.read`

&#x20; - `adgroup.write` (if auto-implementation enabled)

&#x20; - `reporting.read`

&#x20; - `tool.read` (for diagnostic insights)



\### Runtime Environment

\- No local dependencies

\- Cloud-based execution via StationOne or compatible AI platform

\- Minimum data requirement: 3 days of campaign activity for meaningful analysis



\### Additional MCPs

\- \*\*None required\*\* - operates exclusively with TikTok for Business MCP

\- Optional: Analytics MCP for cross-platform comparison (not required)



\---



\## Configuration



\### Default Settings

```yaml

optimization\_mode: recommendations\_only  # Options: recommendations\_only | auto\_implement

date\_range: 7                            # Days of historical data to analyze

pacing\_tolerance: 0.10                   # ±10% variance threshold

max\_budget\_multiplier: 2.0               # Never increase budgets more than 2x

min\_data\_threshold: 3                    # Minimum days before making changes

performance\_check\_frequency: daily       # Options: daily | weekly

```



\### Configurable Parameters



| Parameter | Description | Default | Valid Range |

|-----------|-------------|---------|-------------|

| `optimization\_goal` | Primary KPI to optimize | CPA | CPA, ROAS, CTR, Conversions |

| `target\_metric\_value` | Target threshold (e.g., CPA < $15) | User-defined | Any positive number |

| `segmentation\_thresholds` | Performance tier boundaries | ±20% of target | -100% to +100% |

| `auto\_pause\_enabled` | Allow automatic pausing of underperformers | false | true/false |

| `budget\_adjustment\_step` | Incremental budget change % | 20% | 5% - 50% |

| `require\_approval` | Confirm before implementing changes | true | true/false |



\### Environment Variables

```

TIKTOK\_ADVERTISER\_ID=<your\_advertiser\_id>

OPTIMIZATION\_MODE=recommendations\_only

TARGET\_CPA=15.00

```



\---



\## Common Errors and Troubleshooting



\### Error: "Insufficient data for optimization"

\*\*Cause:\*\* Ad group has fewer than 3 days of activity or <50 impressions  

\*\*Solution:\*\* 

\- Wait for more data to accumulate

\- Lower `min\_data\_threshold` to 1 day (not recommended for statistical validity)

\- Check if ad group is in "Learning" phase



\### Error: "API permission denied: adgroup.write"

\*\*Cause:\*\* Account lacks permissions to modify ad groups  

\*\*Solution:\*\*

\- Enable auto-implementation only if you have Admin/Operator role

\- Use `recommendations\_only` mode (default)

\- Contact your TikTok Business Manager admin for write permissions



\### Warning: "No performance change detected after optimization"

\*\*Cause:\*\* Changes may need 24-48 hours to take effect  

\*\*Solution:\*\*

\- TikTok's algorithm requires time to re-enter learning phase

\- Wait 3-7 days before re-optimizing the same ad group

\- Check if competing campaigns are affecting delivery



\### Error: "Campaign ID not found"

\*\*Cause:\*\* Invalid campaign ID or access restrictions  

\*\*Solution:\*\*

\- Verify campaign ID via TikTok Ads Manager

\- Ensure campaign belongs to the authenticated Advertiser ID

\- Check if campaign is archived or deleted



\### Performance Issue: "Analysis taking >2 minutes"

\*\*Cause:\*\* Large campaign with 50+ ad groups  

\*\*Solution:\*\*

\- Reduce `date\_range` to 3-5 days

\- Analyze specific ad group IDs instead of entire campaign

\- Run analysis during off-peak hours



\---



\## Limitations and Caveats



\### Known Limitations

1\. \*\*Learning Phase Blindness\*\*: Cannot force ad groups out of learning phase (TikTok platform limitation)

2\. \*\*Smart+ Campaign Restrictions\*\*: Limited optimization for Smart+ campaigns (bid/budget controlled by TikTok's algorithm)

3\. \*\*Historical Data Cap\*\*: Performance analysis limited to last 90 days (API constraint)

4\. \*\*Concurrent Modifications\*\*: If manual changes are made via Ads Manager during optimization, conflicts may occur



\### Edge Cases

\- \*\*Seasonal Campaigns\*\*: Holiday/event campaigns may show artificially high performance that won't sustain

\- \*\*New Product Launches\*\*: Initial performance may not be representative of long-term trends

\- \*\*Budget Exhaustion\*\*: If campaign hits lifetime budget cap, recommendations may be irrelevant

\- \*\*Multi-Currency Accounts\*\*: Budget recommendations assume single currency; manual adjustment needed for mixed-currency campaigns



\### Best Practices

\- ✅ Run optimization weekly for most campaigns

\- ✅ Use `recommendations\_only` mode initially to understand impact

\- ✅ Never optimize same ad group more than once per 72 hours

\- ✅ Combine with Campaign Health Auditor for comprehensive analysis

\- ⚠️ Avoid auto-implementation during major sales events without monitoring

\- ⚠️ Don't optimize ad groups with <1000 impressions (statistical noise)



\---



\## Contact Information



\### Maintainer

\*\*Kochava Inc. - StationOne Product Team\*\*  

Email: support@stationone.ai  



\---



\*\*Version:\*\* 1.0.1 

\*\*Last Updated:\*\* June 2026  

\*\*License:\*\* Proprietary - Kochava Inc.  

\*\*Skill Package:\*\* `kochava-ad-group-optimizer-v1.0.1.zip`

