#!/usr/bin/env python3
"""
Odoo Module Management Tool

Lists, analyzes, and manages Odoo modules. Useful for understanding current
installation state and identifying problematic modules.
"""

import sys
import argparse
from odoo import api, SUPERUSER_ID
import odoo.tools.config as config


def get_modules_by_status(database, status_filter=None):
    """Get modules filtered by status."""
    
    config.parse_config([])
    config['db_host'] = 'db'
    config['db_port'] = 5432
    config['db_user'] = 'odoo'
    config['db_password'] = 'odoo'
    
    registry = odoo.registry(database)
    
    with registry.cursor() as cr:
        env = api.Environment(cr, SUPERUSER_ID, {})
        
        domain = []
        if status_filter:
            if isinstance(status_filter, str):
                domain.append(('state', '=', status_filter))
            elif isinstance(status_filter, list):
                domain.append(('state', 'in', status_filter))
        
        modules = env['ir.module.module'].search(domain, order='name')
        
        module_data = []
        for module in modules:
            module_info = {
                'name': module.name,
                'state': module.state,
                'installed_version': module.installed_version,
                'latest_version': module.latest_version,
                'summary': module.summary or 'No description',
                'author': module.author or 'Unknown',
                'depends': [dep.name for dep in module.dependencies_id],
                'auto_install': module.auto_install,
                'application': module.application,
            }
            module_data.append(module_info)
        
        return module_data


def analyze_custom_modules(modules):
    """Identify potentially custom modules."""
    custom_indicators = [
        'vainplex', 'custom', 'local', 'company', 'private'
    ]
    
    custom_modules = []
    for module in modules:
        name_lower = module['name'].lower()
        if any(indicator in name_lower for indicator in custom_indicators):
            custom_modules.append(module)
    
    return custom_modules


def find_problematic_modules(modules):
    """Find modules that might cause issues."""
    problematic = []
    
    for module in modules:
        issues = []
        
        # Check for problematic states
        if module['state'] in ['to upgrade', 'to remove', 'to install']:
            issues.append(f"Pending state: {module['state']}")
        
        # Check for version mismatches
        if (module['installed_version'] and module['latest_version'] and
            module['installed_version'] != module['latest_version']):
            issues.append(f"Version mismatch: {module['installed_version']} vs {module['latest_version']}")
        
        # Check for missing dependencies (basic check)
        if not module['depends'] and module['state'] == 'installed' and not module['application']:
            issues.append("No dependencies (unusual)")
        
        if issues:
            module['issues'] = issues
            problematic.append(module)
    
    return problematic


def print_module_table(modules, title="Modules"):
    """Print modules in a formatted table."""
    if not modules:
        print(f"No {title.lower()} found.")
        return
    
    print(f"\n{title} ({len(modules)}):")
    print("─" * 80)
    print(f"{'Name':<30} {'State':<15} {'Version':<15} {'Summary':<20}")
    print("─" * 80)
    
    for module in modules:
        name = module['name'][:29]
        state = module['state']
        version = module['installed_version'] or 'N/A'
        summary = (module['summary'] or '')[:19]
        
        # Color coding for state
        state_color = ""
        if module['state'] == 'installed':
            state_color = "✅"
        elif module['state'] in ['to upgrade', 'to install', 'to remove']:
            state_color = "⚠️ "
        elif module['state'] == 'uninstalled':
            state_color = "⭕"
        
        print(f"{name:<30} {state_color}{state:<13} {version:<15} {summary}")
    
    print()


def print_module_details(modules, show_dependencies=False):
    """Print detailed module information."""
    for module in modules:
        print(f"\n📦 {module['name']}")
        print(f"   State: {module['state']}")
        print(f"   Version: {module['installed_version'] or 'Not installed'}")
        print(f"   Author: {module['author']}")
        print(f"   Summary: {module['summary'] or 'No description'}")
        
        if show_dependencies and module['depends']:
            print(f"   Dependencies: {', '.join(module['depends'])}")
        
        if 'issues' in module:
            print(f"   ❌ Issues:")
            for issue in module['issues']:
                print(f"      - {issue}")


def main():
    parser = argparse.ArgumentParser(description='List and analyze Odoo modules')
    parser.add_argument('--database', '-d', default='vainplex', help='Database name')
    parser.add_argument('--status', choices=['installed', 'uninstalled', 'to upgrade', 'to install', 'to remove'],
                       help='Filter by module status')
    parser.add_argument('--custom-only', action='store_true',
                       help='Show only custom/company modules')
    parser.add_argument('--problematic-only', action='store_true',
                       help='Show only modules with potential issues')
    parser.add_argument('--details', action='store_true',
                       help='Show detailed module information')
    parser.add_argument('--dependencies', action='store_true',
                       help='Include dependency information')
    parser.add_argument('--format', choices=['table', 'list'], default='table',
                       help='Output format')
    
    args = parser.parse_args()
    
    print(f"📦 Analyzing modules for database: {args.database}")
    
    try:
        # Get modules
        modules = get_modules_by_status(args.database, args.status)
        
        if not modules:
            print("No modules found matching criteria.")
            return
        
        # Apply filters
        if args.custom_only:
            modules = analyze_custom_modules(modules)
            title = "Custom Modules"
        elif args.problematic_only:
            modules = find_problematic_modules(modules)
            title = "Problematic Modules"
        else:
            title = f"Modules ({args.status or 'all statuses'})"
        
        # Output results
        if args.format == 'table' and not args.details:
            print_module_table(modules, title)
        else:
            print_module_details(modules, args.dependencies)
        
        # Summary statistics
        if not args.custom_only and not args.problematic_only:
            status_counts = {}
            for module in modules:
                status = module['state']
                status_counts[status] = status_counts.get(status, 0) + 1
            
            print("📊 Status Summary:")
            for status, count in sorted(status_counts.items()):
                print(f"   {status}: {count}")
        
        # Additional analysis
        if not args.status:  # Only if showing all modules
            custom_modules = analyze_custom_modules(modules)
            if custom_modules:
                print(f"\n🏢 Custom modules detected: {len(custom_modules)}")
                for module in custom_modules[:5]:  # Show first 5
                    print(f"   - {module['name']} ({module['state']})")
                if len(custom_modules) > 5:
                    print(f"   ... and {len(custom_modules) - 5} more")
            
            problematic = find_problematic_modules(modules)
            if problematic:
                print(f"\n⚠️  Modules with issues: {len(problematic)}")
                for module in problematic[:3]:  # Show first 3
                    print(f"   - {module['name']}: {', '.join(module['issues'])}")
                if len(problematic) > 3:
                    print(f"   ... and {len(problematic) - 3} more")
    
    except Exception as e:
        print(f"❌ Error: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()