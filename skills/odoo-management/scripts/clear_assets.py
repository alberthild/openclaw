#!/usr/bin/env python3
"""
Odoo Asset Cache Management

Clears cached CSS/JS assets to force regeneration. Useful when theme changes
don't appear or when debugging asset-related issues.
"""

import sys
import argparse
import os
import glob
from odoo import api, SUPERUSER_ID
import odoo.tools.config as config


def clear_database_assets(database, asset_types=None):
    """Clear cached assets from database."""
    
    config.parse_config([])
    config['db_host'] = 'db'
    config['db_port'] = 5432
    config['db_user'] = 'odoo'
    config['db_password'] = 'odoo'
    
    registry = odoo.registry(database)
    
    with registry.cursor() as cr:
        env = api.Environment(cr, SUPERUSER_ID, {})
        
        # Build search domain
        domain = [('res_model', '=', 'ir.ui.view')]
        
        if asset_types:
            type_conditions = []
            for asset_type in asset_types:
                if asset_type == 'css':
                    type_conditions.append(('name', 'ilike', '%.css'))
                elif asset_type == 'js':
                    type_conditions.append(('name', 'ilike', '%.js'))
                elif asset_type == 'assets':
                    type_conditions.extend([
                        ('name', 'ilike', '%assets%'),
                        ('name', 'ilike', '%.bundle')
                    ])
            
            if len(type_conditions) > 1:
                domain.append('|' * (len(type_conditions) - 1))
            domain.extend(type_conditions)
        else:
            # Default: clear CSS and JS files
            domain.extend(['|', ('name', 'ilike', '%.css'), ('name', 'ilike', '%.js')])
        
        assets = env['ir.attachment'].search(domain)
        
        if assets:
            count = len(assets)
            # Show what we're deleting
            for asset in assets[:10]:  # Show first 10
                print(f"   Deleting: {asset.name}")
            if count > 10:
                print(f"   ... and {count - 10} more")
            
            assets.unlink()
            cr.commit()
            print(f"🗑️  Deleted {count} cached assets from database")
            return count
        else:
            print("ℹ️  No cached assets found in database")
            return 0


def clear_filestore_assets(filestore_path):
    """Clear cached assets from filestore directory."""
    
    if not os.path.exists(filestore_path):
        print(f"⚠️  Filestore path not found: {filestore_path}")
        return 0
    
    patterns = ['**/*.css', '**/*.js', '**/*.bundle']
    deleted_count = 0
    
    for pattern in patterns:
        files = glob.glob(os.path.join(filestore_path, pattern), recursive=True)
        for file_path in files:
            try:
                os.remove(file_path)
                print(f"   Deleted: {os.path.relpath(file_path, filestore_path)}")
                deleted_count += 1
            except OSError as e:
                print(f"   Failed to delete {file_path}: {e}")
    
    if deleted_count > 0:
        print(f"🗑️  Deleted {deleted_count} cached files from filestore")
    else:
        print("ℹ️  No cached files found in filestore")
    
    return deleted_count


def force_asset_regeneration(database):
    """Force asset regeneration by updating system parameters."""
    
    registry = odoo.registry(database)
    
    with registry.cursor() as cr:
        env = api.Environment(cr, SUPERUSER_ID, {})
        
        # Update parameters that trigger asset regeneration
        regen_params = [
            ('web.base_url_freeze_date', 'false'),
            ('web.assets_debug', 'false'),
        ]
        
        for key, value in regen_params:
            env['ir.config_parameter'].sudo().set_param(key, value)
            print(f"   Updated {key} = {value}")
        
        # Clear QWeb template cache
        env.registry.clear_cache()
        
        cr.commit()
        print("🔄 Forced asset regeneration trigger")


def main():
    parser = argparse.ArgumentParser(description='Clear Odoo cached assets')
    parser.add_argument('--database', '-d', default='vainplex', help='Database name')
    parser.add_argument('--filestore', help='Filestore path (e.g., /var/lib/odoo/filestore/vainplex)')
    parser.add_argument('--types', nargs='+', choices=['css', 'js', 'assets'], 
                       help='Asset types to clear (default: css js)')
    parser.add_argument('--force-regenerate', action='store_true',
                       help='Force asset regeneration after clearing')
    parser.add_argument('--nuclear', action='store_true',
                       help='Nuclear option: clear everything and force regeneration')
    
    args = parser.parse_args()
    
    print(f"🗑️  Clearing cached assets for database: {args.database}")
    
    # Determine asset types
    asset_types = args.types or ['css', 'js']
    if args.nuclear:
        asset_types = ['css', 'js', 'assets']
    
    print(f"   Types: {', '.join(asset_types)}")
    print()
    
    try:
        total_deleted = 0
        
        # Clear database assets
        db_deleted = clear_database_assets(args.database, asset_types)
        total_deleted += db_deleted
        
        # Clear filestore assets if path provided
        if args.filestore:
            fs_deleted = clear_filestore_assets(args.filestore)
            total_deleted += fs_deleted
        
        # Force regeneration if requested
        if args.force_regenerate or args.nuclear:
            force_asset_regeneration(args.database)
        
        print(f"\n✅ Asset clearing complete!")
        print(f"   Total deleted: {total_deleted}")
        if total_deleted > 0:
            print(f"   💡 Restart containers to apply changes: docker-compose restart")
        
    except Exception as e:
        print(f"❌ Error: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()