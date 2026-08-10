"""Standalone Kiwoom Securities API integration.

Kept separate from the Toss-based mumae engine (toss_api.py,
application_engine.py, etc.) -- different broker, different account
holders (children's Kiwoom accounts), different auth/endpoint contract.
Nothing here is imported by or imports the main engine.
"""
