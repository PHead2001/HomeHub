

'use client';

import { useState, useCallback } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ShoppingListClient } from './shopping-list-client';
import { PantryInventoryClient } from '@/components/pantry-inventory-client';
import { ClipboardList, Archive } from 'lucide-react';
import type { PantryItem, ShoppingList } from '@/lib/types';


export function ShoppingCenterClient() {
    const [activeTab, setActiveTab] = useState('lists');
    const [itemToAddToPantry, setItemToAddToPantry] = useState<PantryItem | null>(null);
    const [listToReturnTo, setListToReturnTo] = useState<ShoppingList | null>(null);
    const [selectedList, setSelectedList] = useState<ShoppingList | null>(null);
    
    const handleAddItemToPantry = useCallback((item: PantryItem, currentList: ShoppingList) => {
        setItemToAddToPantry(item);
        setListToReturnTo(currentList);
        setActiveTab('inventory');
    }, []);

    const handleFinishAdding = useCallback(() => {
        setItemToAddToPantry(null);
        if (listToReturnTo) {
            setSelectedList(listToReturnTo);
            setActiveTab('lists');
        }
        setListToReturnTo(null);
    }, [listToReturnTo]);

    const handleListSelection = useCallback((list: ShoppingList | null) => {
        setSelectedList(list);
    }, []);

    return (
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="lists"><ClipboardList className="mr-2"/> Shopping Lists</TabsTrigger>
                <TabsTrigger value="inventory"><Archive className="mr-2"/> Inventory</TabsTrigger>
            </TabsList>
            <TabsContent value="lists">
                <ShoppingListClient 
                    onAddItemToPantry={handleAddItemToPantry}
                    selectedList={selectedList}
                    onSelectList={handleListSelection}
                />
            </TabsContent>
            <TabsContent value="inventory">
                <PantryInventoryClient 
                    itemToAddToPantry={itemToAddToPantry}
                    onFinishAddingToPantry={handleFinishAdding}
                />
            </TabsContent>
        </Tabs>
    );
}
