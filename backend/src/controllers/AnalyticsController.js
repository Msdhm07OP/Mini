import analyticsService, { toCsv } from '../services/analyticsService.js';
import simulationService from '../services/simulationService.js';
import logger from '../utils/logger/index.js';

/**
 * Analytics, data-quality and simulation endpoints.
 *
 * Controllers stay thin: parse query parameters, delegate, respond. All metric
 * logic lives in SQL views and the analytics service.
 */
class AnalyticsController {
  filters(req) {
    return {
      date_from: req.query.date_from,
      date_to: req.query.date_to,
      venue_id: req.query.venue_id,
      limit: req.query.limit,
      severity: req.query.severity,
    };
  }

  wrap(handler) {
    return async (req, res, next) => {
      try {
        const data = await handler(this.filters(req), req);
        res.json({ success: true, ...data });
      } catch (error) {
        if (error.name === 'ZodError') {
          return res.status(400).json({
            success: false,
            message: 'Validation failed',
            errors: error.errors.map(e => `${e.path.join('.')}: ${e.message}`),
          });
        }
        if (error.status === 400) {
          return res.status(400).json({ success: false, message: error.message });
        }
        next(error);
      }
    };
  }

  overview = this.wrap(async (filters) => {
    const [outcomes, venues, resources, quality] = await Promise.all([
      analyticsService.requestOutcomes(filters),
      analyticsService.venueUtilisation(filters),
      analyticsService.resourceDemand(filters),
      analyticsService.dataQuality({ limit: 1000 }),
    ]);
    return {
      totals: outcomes.totals,
      definitions: {
        outcomes: outcomes.definition,
        venue_utilisation: venues.definition,
        resource_demand: resources.definition,
      },
      venue_utilisation: venues.rows,
      resource_bottlenecks: resources.bottlenecks,
      data_quality: {
        total_findings: quality.total_findings,
        by_severity: quality.by_severity,
      },
    };
  });

  requestOutcomes = this.wrap(filters => analyticsService.requestOutcomes(filters));
  hallUtilisation = this.wrap(filters => analyticsService.hallUtilisation(filters));
  venueUtilisation = this.wrap(filters => analyticsService.venueUtilisation(filters));
  resourceDemand = this.wrap(filters => analyticsService.resourceDemand(filters));
  demandHeatmap = this.wrap(filters => analyticsService.demandHeatmap(filters));
  rejectionAnalysis = this.wrap(filters => analyticsService.rejectionAnalysis(filters));
  lifecycleTrends = this.wrap(filters => analyticsService.lifecycleTrends(filters));
  dataQuality = this.wrap(filters => analyticsService.dataQuality(filters));

  /**
   * CSV export. Datasets are whitelisted in the service; the filename is built
   * from that whitelist rather than from user input.
   */
  async exportCsv(req, res, next) {
    try {
      const dataset = String(req.params.dataset || '');
      const rows = await analyticsService.exportRows(dataset, {
        date_from: req.query.date_from,
        date_to: req.query.date_to,
        venue_id: req.query.venue_id,
        limit: req.query.limit,
      });

      const csv = toCsv(rows);
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition',
        `attachment; filename="eventsync-${dataset}-${stamp}.csv"`);
      // Stops a browser from sniffing the CSV as something executable.
      res.setHeader('X-Content-Type-Options', 'nosniff');
      logger.info?.('CSV export served', {
        correlationId: req.correlationId, dataset, rows: rows.length,
      });
      res.send(csv || '');
    } catch (error) {
      if (error.status === 400) {
        return res.status(400).json({ success: false, message: error.message });
      }
      next(error);
    }
  }

  /**
   * What-if simulation. Read-only: returns hypothetical outcomes and writes
   * nothing, which is why it is a POST that creates no resource.
   */
  async simulate(req, res, next) {
    try {
      const result = await simulationService.simulate(req.body, req.correlationId);
      res.json({ success: true, ...result });
    } catch (error) {
      if (error.name === 'ZodError') {
        return res.status(400).json({
          success: false,
          message: 'Validation failed',
          errors: error.errors.map(e => `${e.path.join('.')}: ${e.message}`),
        });
      }
      next(error);
    }
  }
}

export default new AnalyticsController();
