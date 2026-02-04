---
name: odoo-management
description: Comprehensive Odoo ERP system management including version upgrades, database migrations, module management, and Vainplex-specific customizations. Use when upgrading Odoo installations, migrating databases, fixing module conflicts, managing custom themes/colors, troubleshooting Odoo deployments, or performing systematic version migrations from older Odoo versions to current releases.
---

# Odoo Management

## Overview

This skill provides systematic workflows for managing Odoo ERP installations, focusing on version upgrades, database migrations, and custom module management. Particularly optimized for Vainplex-specific configurations and gradual upgrade paths.

## Workflow Decision Tree

**Choose your path:**

1. **Version Upgrade** → Use [Version Upgrade Workflow](#version-upgrade-workflow)
2. **Database Migration** → Use [Database Migration](#database-migration)
3. **Module Issues** → Use [Module Management](#module-management)
4. **Theme/Asset Problems** → Use [Theme Management](#theme-management)
5. **General Troubleshooting** → Use [Troubleshooting](#troubleshooting)

## Version Upgrade Workflow

**Progressive upgrade strategy for complex installations:**

### 1. Pre-Upgrade Assessment

```bash
# Check current version
docker-compose exec web python3 -c "import odoo; print(odoo.release.version)"

# Identify installed modules
scripts/list_modules.py --status installed

# Check for custom modules
scripts/analyze_custom_modules.py
```

### 2. Backup Everything

**Critical - Never skip this step:**

```bash
# Database backup
docker-compose exec db pg_dump -U odoo vainplex > backup_$(date +%Y%m%d).sql

# Filestore backup
docker-compose exec web tar -czf /tmp/filestore_backup.tar.gz /var/lib/odoo/filestore/

# Configuration backup
cp -r ./config ./config_backup_$(date +%Y%m%d)
```

### 3. Incremental Upgrade Process

**Never jump more than one major version:**

```
Current: 16.0 → 17.0 → 18.0 → Latest
```

For each version step:

1. **Update docker-compose.yml** to next version
2. **Run migration scripts** (see scripts/migrate_version.py)
3. **Test critical workflows**
4. **Fix broken modules**
5. **Validate before next step**

### 4. Post-Upgrade Validation

- [ ] Login works
- [ ] Critical modules loaded
- [ ] Custom themes applied
- [ ] Data integrity check
- [ ] Performance baseline

## Database Migration

Use when moving between different database setups or major schema changes.

**Safe migration process:**

1. Export with `scripts/export_database.py`
2. Transform schema if needed
3. Import with validation
4. Run integrity checks

See [references/database_migration.md](references/database_migration.md) for detailed procedures.

## Module Management

**Common scenarios:**

### Broken Module Resolution

```python
# Identify conflicts
scripts/find_module_conflicts.py

# Safe module removal
scripts/remove_module_safely.py --module broken-module-name

# Module dependency analysis
scripts/analyze_dependencies.py --target vainplex_odoo_base
```

### Custom Module Updates

For Vainplex modules specifically:

1. Update manifest files
2. Migrate custom views
3. Update color configurations
4. Test theme compatibility

See [references/vainplex_modules.md](references/vainplex_modules.md)

## Theme Management

**Vainplex theme issues and color management:**

### Color Configuration

```python
# Set Vainplex brand colors
scripts/set_vainplex_colors.py --primary "#DC143C" --secondary "#000000"

# Clear asset cache
scripts/clear_assets.py --force-regenerate

# Create CSS overrides
scripts/create_theme_override.py --template vainplex
```

### Asset Troubleshooting

- Clear all cached assets
- Force CSS regeneration
- Apply nuclear CSS overrides
- Validate color inheritance

## Troubleshooting

**Common Odoo issues and solutions:**

### Container Issues

- Network problems (reverse-proxy setup)
- Volume mounting issues
- Permission problems

### Database Problems

- Connection timeouts
- Migration failures
- Corrupted modules

### Performance Issues

- Asset generation slowdown
- Database query optimization
- Module loading bottlenecks

For detailed troubleshooting guides, see [references/troubleshooting.md](references/troubleshooting.md)

## Critical Commands

**Essential Odoo management commands:**

```bash
# Module operations
docker-compose exec web odoo -d vainplex -u module_name --stop-after-init
docker-compose exec web odoo -d vainplex -i module_name --stop-after-init

# Database operations
docker-compose exec web odoo -d vainplex --db-filter=vainplex$ --stop-after-init

# Asset operations
docker-compose exec web odoo -d vainplex --dev=reload,qweb,werkzeug,xml
```

## Resources

### scripts/

- `list_modules.py` - Module inventory and status
- `migrate_version.py` - Version-specific migration logic
- `set_vainplex_colors.py` - Brand color configuration
- `clear_assets.py` - Asset cache management
- `backup_system.py` - Comprehensive backup utility

### references/

- `database_migration.md` - Detailed migration procedures
- `vainplex_modules.md` - Custom module documentation
- `troubleshooting.md` - Common issues and solutions
- `version_compatibility.md` - Version-specific gotchas
