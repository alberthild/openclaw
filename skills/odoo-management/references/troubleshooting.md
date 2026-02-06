# Odoo Troubleshooting Guide

## Common Issues and Solutions

### Container Issues

#### Container Won't Start

**Symptoms**:

- `docker-compose up` fails
- Container exits immediately
- Network connection errors

**Diagnostic Steps**:

```bash
# Check container status
docker-compose ps

# Check logs
docker-compose logs web
docker-compose logs db

# Check available resources
docker system df
df -h
```

**Common Causes & Solutions**:

1. **Network Issues**

   ```bash
   # Missing external network
   docker network create reverse-proxy_default

   # Check network configuration
   docker network ls
   docker network inspect reverse-proxy_default
   ```

2. **Volume Permission Issues**

   ```bash
   # Fix volume permissions
   docker-compose exec web chown -R odoo:odoo /var/lib/odoo
   docker-compose exec web chmod -R 755 /var/lib/odoo
   ```

3. **Port Conflicts**

   ```bash
   # Check port usage
   netstat -tlnp | grep :8069

   # Change ports in docker-compose.yml if needed
   ports:
     - "8070:8069"  # Use different external port
   ```

#### Database Connection Issues

**Symptoms**:

- "Database connection failed"
- Long startup times
- Connection timeouts

**Solutions**:

```bash
# Check database status
docker-compose exec db psql -U odoo -l

# Test connection manually
docker-compose exec web python3 -c "
import psycopg2
conn = psycopg2.connect(
    host='db', port=5432, user='odoo', password='odoo', database='vainplex'
)
print('Connection successful')
conn.close()
"

# Reset database connections
docker-compose restart db
sleep 10
docker-compose restart web
```

### Module Issues

#### Module Loading Failures

**Symptoms**:

- "Module not found"
- "Dependencies missing"
- "Module state inconsistent"

**Diagnostic Commands**:

```bash
# Check module status
scripts/list_modules.py --problematic-only

# Check module directory structure
docker-compose exec web find /mnt/extra-addons -name "__manifest__.py" -exec dirname {} \;

# Validate module manifest
docker-compose exec web python3 -c "
import ast
with open('/mnt/extra-addons/module_name/__manifest__.py') as f:
    manifest = ast.literal_eval(f.read())
    print('Manifest is valid')
"
```

**Solutions**:

1. **Fix Module Dependencies**

   ```bash
   # Install missing dependencies first
   docker-compose exec web odoo -d vainplex -i dependency_module --stop-after-init

   # Then install target module
   docker-compose exec web odoo -d vainplex -i target_module --stop-after-init
   ```

2. **Reset Module State**

   ```python
   # Access Odoo shell
   module = env['ir.module.module'].search([('name', '=', 'broken_module')])
   module.write({'state': 'uninstalled'})
   ```

3. **Clean Module Installation**

   ```bash
   # Remove module completely
   docker-compose exec web odoo -d vainplex -u broken_module --stop-after-init

   # Reinstall from scratch
   docker-compose exec web odoo -d vainplex -i broken_module --stop-after-init
   ```

#### Module Conflicts

**Symptoms**:

- "Some modules have inconsistent states"
- Modules stuck in "to install" or "to upgrade"
- Conflicting module names

**Resolution Process**:

```bash
# 1. Identify conflicting modules
scripts/list_modules.py --status "to install" --details

# 2. Remove problematic modules
docker-compose exec web python3 -c "
from odoo import registry, api, SUPERUSER_ID
reg = registry('vainplex')
with reg.cursor() as cr:
    env = api.Environment(cr, SUPERUSER_ID, {})
    broken = env['ir.module.module'].search([('name', '=', 'problematic-module')])
    broken.write({'state': 'uninstalled'})
    cr.commit()
"

# 3. Clean restart
docker-compose restart
```

### Asset and Theme Issues

#### CSS Not Loading/Applying

**Symptoms**:

- Styles not visible
- Old colors still showing
- Layout broken

**Diagnostic Steps**:

```bash
# Check asset generation
curl -s "https://erp.vainplex.de/web/login" | grep -o 'assets.*\.css' | head -3

# Check asset files exist
docker-compose exec web find /var/lib/odoo -name "*.css" -newer /tmp

# Check for CSS errors
docker-compose logs web | grep -i "css\|asset"
```

**Solutions**:

```bash
# Nuclear asset reset
scripts/clear_assets.py --nuclear
docker-compose restart

# Force asset regeneration
docker-compose exec web python3 -c "
from odoo import registry, api, SUPERUSER_ID
reg = registry('vainplex')
with reg.cursor() as cr:
    env = api.Environment(cr, SUPERUSER_ID, {})
    env['ir.config_parameter'].sudo().set_param('web.base_url_freeze_date', False)
    cr.commit()
"
```

#### Color Configuration Not Working

**Symptoms**:

- Colors remain default (turquoise)
- Theme changes ignored
- Inconsistent branding

**Solutions**:

```bash
# Apply nuclear color fix
scripts/set_vainplex_colors.py --nuclear

# Check color parameter status
docker-compose exec web python3 -c "
from odoo import registry, api, SUPERUSER_ID
reg = registry('vainplex')
with reg.cursor() as cr:
    env = api.Environment(cr, SUPERUSER_ID, {})
    params = env['ir.config_parameter'].sudo().search([('key', 'ilike', '%color%')])
    for p in params:
        print(f'{p.key} = {p.value}')
"

# Create emergency CSS override
scripts/set_vainplex_colors.py --css-override both
```

### Performance Issues

#### Slow Loading Times

**Symptoms**:

- Pages load slowly
- High CPU usage
- Memory consumption

**Diagnostic Commands**:

```bash
# Check system resources
docker stats
free -h
iostat -x 1 5

# Check database performance
docker-compose exec db psql -U odoo -d vainplex -c "
SELECT query, calls, total_time, mean_time
FROM pg_stat_statements
ORDER BY total_time DESC
LIMIT 10;"

# Check Odoo log level
docker-compose logs web | grep -i "warning\|error" | tail -20
```

**Optimization Steps**:

1. **Increase Memory Limits**

   ```yaml
   # In docker-compose.yml
   services:
     web:
       deploy:
         resources:
           limits:
             memory: 2G
           reservations:
             memory: 1G
   ```

2. **Database Optimization**

   ```bash
   # Analyze database
   docker-compose exec db psql -U odoo -d vainplex -c "ANALYZE;"

   # Vacuum database
   docker-compose exec db psql -U odoo -d vainplex -c "VACUUM ANALYZE;"
   ```

3. **Asset Optimization**
   ```bash
   # Disable debug mode
   docker-compose exec web python3 -c "
   from odoo import registry, api, SUPERUSER_ID
   reg = registry('vainplex')
   with reg.cursor() as cr:
       env = api.Environment(cr, SUPERUSER_ID, {})
       env['ir.config_parameter'].sudo().set_param('web.assets_debug', False)
       cr.commit()
   "
   ```

### Database Issues

#### Database Corruption

**Symptoms**:

- "Database is corrupted" errors
- Data inconsistencies
- Transaction failures

**Recovery Steps**:

```bash
# 1. Stop Odoo
docker-compose stop web

# 2. Check database integrity
docker-compose exec db psql -U odoo -d vainplex -c "
SELECT schemaname, tablename, attname, n_distinct, correlation
FROM pg_stats
WHERE schemaname = 'public' AND n_distinct < 0
ORDER BY n_distinct;"

# 3. Repair if possible
docker-compose exec db psql -U odoo -d vainplex -c "REINDEX DATABASE vainplex;"

# 4. Restore from backup if necessary
docker-compose exec db psql -U odoo -c "DROP DATABASE vainplex;"
docker-compose exec db psql -U odoo -c "CREATE DATABASE vainplex;"
docker-compose exec -T db psql -U odoo -d vainplex < backup.sql
```

#### Migration Failures

**Symptoms**:

- Upgrade process stuck
- "Migration script failed"
- Database schema issues

**Recovery Approach**:

```bash
# 1. Rollback to backup
docker-compose down
docker-compose exec -T db psql -U odoo -d vainplex < pre_upgrade_backup.sql

# 2. Try incremental upgrade
# Instead of 16.0 → 18.0, try 16.0 → 17.0 first

# 3. Manual migration
docker-compose exec web odoo -d vainplex --update all --stop-after-init
```

### Emergency Procedures

#### Complete System Recovery

When everything is broken:

```bash
# 1. Stop everything
docker-compose down

# 2. Backup current state
tar -czf emergency_backup_$(date +%Y%m%d_%H%M).tar.gz ./

# 3. Restore from last known good backup
cp -r backup_known_good/* ./

# 4. Start with database only
docker-compose up db

# 5. Restore database
docker-compose exec -T db psql -U odoo -c "DROP DATABASE IF EXISTS vainplex;"
docker-compose exec -T db psql -U odoo -c "CREATE DATABASE vainplex;"
docker-compose exec -T db psql -U odoo -d vainplex < last_good_backup.sql

# 6. Start Odoo in safe mode
docker-compose up web
```

#### Log Analysis Commands

```bash
# Find specific errors
docker-compose logs web | grep -E "(ERROR|CRITICAL|Exception)" | tail -20

# Monitor real-time logs
docker-compose logs -f web | grep -v "INFO"

# Search for module-specific issues
docker-compose logs web | grep "vainplex"

# Check system events
journalctl -u docker -f
```

### Prevention Best Practices

#### Regular Maintenance

```bash
# Weekly tasks
docker-compose exec db psql -U odoo -d vainplex -c "VACUUM ANALYZE;"
scripts/clear_assets.py --types assets
docker system prune -f

# Monthly tasks
# Full backup
scripts/backup_system.py --full

# Update containers
docker-compose pull
docker-compose up -d
```

#### Monitoring Setup

- Set up log rotation for Docker logs
- Monitor disk space usage
- Track database size growth
- Monitor response times

#### Change Management

- Always backup before changes
- Test in development first
- Document all customizations
- Keep rollback procedures ready
