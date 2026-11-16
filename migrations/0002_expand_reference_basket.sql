-- Expand the monitored basket to all 34 ETFs listed by the supplied reference page.
INSERT INTO etfs(code,tcode,name,index_name,group_name,huijin_yi) VALUES
  ('515330','sh515330','沪深300ETF天弘','沪深300','core',NULL),
  ('159977','sz159977','创业板ETF天弘','创业板指','core',NULL),
  ('563360','sh563360','A500ETF华泰柏瑞','中证A500','core',NULL),
  ('159361','sz159361','A500ETF易方达','中证A500','core',NULL),
  ('159352','sz159352','A500ETF南方','中证A500','core',NULL),
  ('563800','sh563800','A500ETF广发','中证A500','core',NULL),
  ('563220','sh563220','A500ETF富国','中证A500','core',NULL),
  ('159351','sz159351','A500ETF嘉实','中证A500','core',NULL),
  ('159633','sz159633','中证1000ETF易方达','中证1000','core',NULL),
  ('510100','sh510100','上证50ETF易方达','上证50','core',NULL),
  ('560050','sh560050','MSCI中国A50ETF汇添富','MSCI中国A50','core',NULL)
ON CONFLICT(code) DO UPDATE SET
  tcode=excluded.tcode,
  name=excluded.name,
  index_name=excluded.index_name,
  group_name='core';

-- These three existing watchlist ETFs are members of the reference 34-ETF basket.
UPDATE etfs SET group_name='core',huijin_yi=NULL WHERE code IN ('159338','512050','588000');
UPDATE etfs SET huijin_yi=NULL WHERE code='159339';

-- Re-run local close-history collection so newly added tickers receive a full baseline.
DELETE FROM app_meta WHERE key='daily_closes_checked_for';
