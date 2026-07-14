#!/usr/bin/env python3

import os

def main():
    os.system("git add .")
    os.system("git rm --cached -rf ref || true")
    os.system("git commit")
    os.system("git push")

main()
